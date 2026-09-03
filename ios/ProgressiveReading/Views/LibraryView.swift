import SwiftUI
import UniformTypeIdentifiers

public struct LibraryView: View {
    private enum LoadState: Equatable {
        case loading
        case loaded
        case failed(String)
    }

    @Environment(\.scenePhase) private var scenePhase

    @State private var books: [BookSummary] = []
    @State private var state: LoadState = .loading
    @State private var isUploading: Bool = false
    @State private var importStatus: String = "Verificando servidor…"
    @State private var isImporting: Bool = false
    @State private var showServerSettings: Bool = false
    @State private var alertMessage: String? = nil
    @State private var highlightedBookId: String? = nil

    private let api = ReadingAPIService.shared

    public init() {}

    public var body: some View {
        NavigationStack {
            content
                .navigationTitle("Biblioteca")
                // inlineLarge keeps the large title on the bar's own row, sharing it with the
                // actions, rather than claiming the extra row `.large` would add below them.
                .toolbarTitleDisplayMode(.inlineLarge)
                .toolbar {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button {
                            showServerSettings = true
                        } label: {
                            Label("Configurar servidor", systemImage: "gearshape")
                        }
                    }
                    ToolbarItem(placement: .topBarTrailing) {
                        Button {
                            isImporting = true
                        } label: {
                            Label("Importar livro", systemImage: "plus")
                        }
                        .disabled(isUploading)
                    }
                }
                .overlay {
                    if isUploading { importingOverlay }
                }
                .fileImporter(
                    isPresented: $isImporting,
                    allowedContentTypes: Self.importableTypes,
                    allowsMultipleSelection: false
                ) { result in
                    switch result {
                    case .success(let urls):
                        if let selectedURL = urls.first {
                            Task { await importBook(from: selectedURL) }
                        }
                    case .failure(let error):
                        alertMessage = "Erro ao selecionar arquivo: \(error.localizedDescription)"
                    }
                }
                .sheet(isPresented: $showServerSettings) {
                    ServerSettingsView { await refreshBooks(showSpinner: true) }
                }
                .alert(
                    "Aviso",
                    isPresented: Binding(
                        get: { alertMessage != nil },
                        set: { if !$0 { alertMessage = nil } }
                    )
                ) {
                    Button("OK", role: .cancel) { alertMessage = nil }
                } message: {
                    Text(alertMessage ?? "Ocorreu um erro desconhecido.")
                }
                .task {
                    if case .loading = state { await refreshBooks(showSpinner: true) }
                }
                .onChange(of: scenePhase) { _, newPhase in
                    // Progress can advance from the widget while the app is backgrounded.
                    if newPhase == .active, case .loaded = state {
                        Task { await refreshBooks(showSpinner: false) }
                    }
                }
        }
    }

    private var subtitle: String {
        switch state {
        case .loading:
            return "Carregando…"
        case .failed:
            return "Sem conexão com o servidor"
        case .loaded:
            if books.isEmpty { return "Nenhum livro importado" }
            return books.count == 1 ? "1 livro" : "\(books.count) livros"
        }
    }

    // MARK: - Content

    @ViewBuilder
    private var content: some View {
        switch state {
        case .loading:
            ProgressView("Carregando biblioteca…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Color(.systemGroupedBackground))

        case .failed(let message):
            ContentUnavailableView {
                Label("Sem conexão com o servidor", systemImage: "antenna.radiowaves.left.and.right.slash")
            } description: {
                Text(message)
            } actions: {
                Button("Tentar novamente") {
                    Task { await refreshBooks(showSpinner: true) }
                }
                Button("Servidor") { showServerSettings = true }
            }

        case .loaded where books.isEmpty:
            ContentUnavailableView {
                Label("Sua biblioteca está vazia", systemImage: "books.vertical")
            } description: {
                Text("Importe um arquivo .epub para iniciar a leitura progressiva.")
            } actions: {
                Button {
                    isImporting = true
                } label: {
                    Label("Importar livro (.epub)", systemImage: "plus")
                }
            }

        case .loaded:
            List {
                Section {
                    ForEach(books) { book in
                        NavigationLink {
                            ReaderCardView(editionId: book.id)
                        } label: {
                            BookRowView(book: book)
                        }
                        // Freshly imported book stays highlighted for a beat; the List row
                        // background is the native equivalent of the old custom outline.
                        .listRowBackground(
                            book.id == highlightedBookId
                                ? Color.primary.opacity(0.08)
                                : Color(.secondarySystemGroupedBackground)
                        )
                    }
                } footer: {
                    Text(subtitle)
                }
            }
            .listStyle(.insetGrouped)
            .contentMargins(.top, 14, for: .scrollContent)
            .refreshable { await refreshBooks(showSpinner: false) }
        }
    }

    private var importingOverlay: some View {
        ZStack {
            Color.black.opacity(0.35).ignoresSafeArea()
            VStack(spacing: 14) {
                ProgressView()
                    .controlSize(.large)
                Text(importStatus)
                    .font(.subheadline.weight(.semibold))
                Text("Isso leva alguns segundos.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .padding(28)
            .background(
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .fill(.regularMaterial)
            )
        }
        .transition(.opacity)
    }

    // MARK: - Data

    private func refreshBooks(showSpinner: Bool) async {
        if showSpinner { state = .loading }
        do {
            let list = try await api.fetchBooks()
            withAnimation(.easeInOut(duration: 0.2)) {
                books = list
                state = .loaded
            }
        } catch {
            // A failed background refresh must not wipe a list that is already on screen.
            if books.isEmpty {
                withAnimation { state = .failed(error.localizedDescription) }
            } else {
                state = .loaded
                alertMessage = "Não foi possível atualizar a biblioteca: \(error.localizedDescription)"
            }
        }
    }

    private func importBook(from url: URL) async {
        importStatus = "Verificando servidor…"
        isUploading = true
        defer { isUploading = false }

        let isAccessing = url.startAccessingSecurityScopedResource()
        defer { if isAccessing { url.stopAccessingSecurityScopedResource() } }

        do {
            let data = try readEPUB(at: url)
            importStatus = "Enviando e indexando livro…"
            let imported = try await api.uploadEPUB(data: data, filename: url.lastPathComponent)

            // Show the new book immediately, then reconcile with the server.
            withAnimation(.spring(response: 0.35, dampingFraction: 0.85)) {
                upsert(imported)
                state = .loaded
                highlightedBookId = imported.id
            }
            // Fade the "just imported" outline separately so the modal can close now.
            Task {
                try? await Task.sleep(nanoseconds: 2_000_000_000)
                withAnimation { highlightedBookId = nil }
            }
            await refreshBooks(showSpinner: false)
            WidgetSync.reload()
        } catch {
            alertMessage = "Falha ao importar EPUB: \(error.localizedDescription)"
        }
    }

    private func upsert(_ book: BookSummary) {
        if let index = books.firstIndex(where: { $0.id == book.id }) {
            books[index] = book
        } else {
            books.insert(book, at: 0)
        }
    }

    /// Reads through a file coordinator so iCloud Drive items are materialised first,
    /// and rejects non-EPUB payloads before spending an upload on them.
    private func readEPUB(at url: URL) throws -> Data {
        var coordinationError: NSError?
        var readError: Error?
        var payload: Data?

        NSFileCoordinator().coordinate(readingItemAt: url, options: [], error: &coordinationError) { readURL in
            do { payload = try Data(contentsOf: readURL) } catch { readError = error }
        }

        if let coordinationError { throw coordinationError }
        if let readError { throw readError }
        guard let payload, !payload.isEmpty else {
            throw APIError.unreadableFile("Não foi possível ler o arquivo selecionado.")
        }
        guard payload.count > 4, payload[0] == 0x50, payload[1] == 0x4B else {
            throw APIError.unreadableFile("O arquivo selecionado não é um EPUB válido.")
        }
        return payload
    }

    private static var importableTypes: [UTType] {
        var types: [UTType] = [.epub]
        if let byExtension = UTType(filenameExtension: "epub"), !types.contains(byExtension) {
            types.append(byExtension)
        }
        return types
    }
}

// MARK: - Book row

struct BookRowView: View {
    let book: BookSummary

    private var progress: Double {
        book.total > 0 ? Double(book.completed) / Double(book.total) : 0
    }

    var body: some View {
        HStack(spacing: 12) {
            BookCoverView(book: book)

            VStack(alignment: .leading, spacing: 3) {
                Text(book.title)
                    .font(.headline)
                    .lineLimit(2)

                Text(book.author ?? "Autor desconhecido")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)

                Spacer(minLength: 4)

                ProgressView(value: progress)
                Text("\(book.percent)% lido")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
            }
            .frame(height: 66, alignment: .top)
        }
        .padding(.vertical, 4)
    }
}

/// Book art at the standard 2:3 trim. Real covers are often near-white, so a hairline
/// border keeps them from bleeding into the row background.
private struct BookCoverView: View {
    let book: BookSummary

    private static let width: CGFloat = 44
    private static let height: CGFloat = 66

    var body: some View {
        Group {
            if let url = ReadingAPIService.shared.coverURL(for: book) {
                AsyncImage(url: url) { phase in
                    if let image = phase.image {
                        image
                            .resizable()
                            .aspectRatio(contentMode: .fill)
                    } else {
                        placeholder
                    }
                }
            } else {
                placeholder
            }
        }
        .frame(width: Self.width, height: Self.height)
        .clipShape(RoundedRectangle(cornerRadius: 4, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 4, style: .continuous)
                .strokeBorder(Color.primary.opacity(0.15), lineWidth: 0.5)
        )
        .accessibilityHidden(true)
    }

    private var placeholder: some View {
        ZStack {
            Color(.tertiarySystemFill)
            Image(systemName: "book.closed")
                .font(.system(size: 18))
                .foregroundStyle(.secondary)
        }
    }
}

// MARK: - Server settings

struct ServerSettingsView: View {
    var onSaved: () async -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var urlText: String = ReadingAPIService.shared.serverURLString
    @State private var checkResult: String? = nil
    @State private var checkSucceeded: Bool = false
    @State private var isChecking: Bool = false

    var body: some View {
        NavigationStack {
            Form {
                Section("Endereço do servidor") {
                    TextField("https://exemplo.trycloudflare.com", text: $urlText)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                        .font(.callout.monospaced())

                    Button {
                        Task { await testConnection() }
                    } label: {
                        HStack {
                            Text("Testar conexão")
                            Spacer()
                            if isChecking { ProgressView() }
                        }
                    }
                    .disabled(isChecking || !ReadingAPIService.isValid(urlText))

                    if let checkResult {
                        Label(checkResult, systemImage: checkSucceeded ? "checkmark.circle.fill" : "xmark.circle.fill")
                            .font(.footnote)
                            .foregroundStyle(checkSucceeded ? .green : .red)
                    }
                }

                Section {
                    Button("Restaurar endereço padrão") {
                        urlText = ReadingAPIService.defaultServerURLString
                        checkResult = nil
                    }
                } footer: {
                    Text("O túnel do servidor muda de endereço a cada reinício. Cole aqui a URL atual se a importação parar de funcionar.")
                }
            }
            .navigationTitle("Servidor")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancelar") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Salvar") {
                        ReadingAPIService.shared.serverURLString = urlText
                        dismiss()
                        Task { await onSaved() }
                    }
                    .disabled(!ReadingAPIService.isValid(urlText))
                }
            }
        }
    }

    private func testConnection() async {
        isChecking = true
        defer { isChecking = false }

        let previous = ReadingAPIService.shared.serverURLString
        ReadingAPIService.shared.serverURLString = urlText
        defer { ReadingAPIService.shared.serverURLString = previous }

        do {
            let health = try await ReadingAPIService.shared.checkHealth()
            checkSucceeded = true
            checkResult = "Conectado (\(health.provider ?? health.status))"
        } catch {
            checkSucceeded = false
            checkResult = error.localizedDescription
        }
    }
}
