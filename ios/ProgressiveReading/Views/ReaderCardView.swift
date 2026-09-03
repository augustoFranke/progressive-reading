import SwiftUI

public struct ReaderCardView: View {
    public let editionId: String

    @AppStorage("readerFontSize") private var fontSize: Double = 16.0
    @State private var title: String = ""
    @State private var author: String? = nil
    @State private var currentCard: CardItem? = nil
    @State private var fragmentIndex: Int = 1
    @State private var totalFragments: Int = 1
    @State private var progressPercent: Int = 0
    @State private var isLoading: Bool = true
    @State private var isAdvancing: Bool = false
    @State private var showResetConfirmation: Bool = false
    @State private var errorMessage: String? = nil
    @State private var displayedText: String = ""
    @State private var fittedWordCount: Int = 0
    @State private var cardSize: CGSize = .zero

    private let api = ReadingAPIService.shared
    private let feedback = UIImpactFeedbackGenerator(style: .medium)

    public init(editionId: String) {
        self.editionId = editionId
    }

    private var canRewind: Bool {
        guard let card = currentCard else { return false }
        return card.cardIndex > 0 || fragmentIndex > 1
    }

    public var body: some View {
        ZStack {
            Color(.systemGroupedBackground)
                .ignoresSafeArea()

            if isLoading {
                ProgressView("Carregando...")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            } else if let card = currentCard {
                VStack(spacing: 12) {
                    // Book title lives in the navigation bar; this row carries position only.
                    Text("Frag \(fragmentIndex)/\(totalFragments) • Card \(card.cardIndex + 1)/\(card.totalCards) • \(progressPercent)%")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .trailing)
                        .padding(.horizontal, 20)
                        .padding(.top, 4)

                    ProgressView(value: Double(progressPercent), total: 100)
                        .padding(.horizontal, 20)

                    // Maximized Literary Prose Card
                    VStack(alignment: .leading, spacing: 0) {
                        Text(displayedText.isEmpty ? card.text : displayedText)
                            .font(.system(size: CGFloat(fontSize), design: .serif))
                            .lineSpacing(6)
                            .foregroundStyle(.primary)
                            .multilineTextAlignment(.leading)
                            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                            .padding(20)
                            .background {
                                GeometryReader { geo in
                                    Color.clear
                                        .onAppear { updateFit(size: geo.size) }
                                        .onChange(of: geo.size) { _, size in updateFit(size: size) }
                                        .onChange(of: fontSize) { _, _ in updateFit(size: geo.size) }
                                }
                            }
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background {
                        RoundedRectangle(cornerRadius: 20, style: .continuous)
                            .fill(Color(.secondarySystemGroupedBackground))
                            .shadow(color: .black.opacity(0.04), radius: 8, x: 0, y: 2)
                    }
                    .padding(.horizontal, 16)
                    .contentShape(Rectangle())
                    .onTapGesture {
                        Task { await advance() }
                    }

                    // Bottom Bar: Rewind + Advance
                    HStack(spacing: 12) {
                        Button {
                            Task { await rewind() }
                        } label: {
                            Image(systemName: "arrow.uturn.backward")
                                .frame(height: 22)
                        }
                        .buttonStyle(.bordered)
                        .controlSize(.large)
                        .disabled(!canRewind)
                        .accessibilityLabel("Voltar")

                        Button {
                            Task { await advance() }
                        } label: {
                            HStack(spacing: 6) {
                                Text(isCompletingFragment(card) ? "Concluir Fragmento (\(fragmentIndex)/\(totalFragments))" : "Próximo Trecho (\(card.cardIndex + 1)/\(card.totalCards))")
                                Image(systemName: isCompletingFragment(card) ? "checkmark.circle.fill" : "chevron.right")
                            }
                            .font(.subheadline.bold())
                            // The app tint is Color.primary, so the prominent fill flips
                            // black/white with the scheme; the label must flip with it.
                            .foregroundStyle(Color(.systemBackground))
                            .frame(maxWidth: .infinity)
                            .frame(height: 22)
                        }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.large)
                    }
                    .padding(.horizontal, 16)
                    .padding(.bottom, 8)
                }
            } else if let error = errorMessage {
                ContentUnavailableView {
                    Label("Não foi possível carregar", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(error)
                } actions: {
                    Button("Tentar Novamente") {
                        Task { await loadCard() }
                    }
                }
            }
        }
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                // Font Size Adjuster (A- / A+)
                HStack(spacing: 0) {
                    Button(action: {
                        if fontSize > 12 { fontSize -= 1 }
                    }) {
                        Image(systemName: "textformat.size.smaller")
                            .font(.caption)
                    }

                    Button(action: {
                        if fontSize < 26 { fontSize += 1 }
                    }) {
                        Image(systemName: "textformat.size.larger")
                            .font(.caption)
                    }
                }

                // Options Menu (Reset, info)
                Menu {
                    Button(role: .destructive, action: {
                        showResetConfirmation = true
                    }) {
                        Label("Reiniciar Livro do Início", systemImage: "arrow.counterclockwise")
                    }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
            }
        }
        .confirmationDialog(
            "Deseja reiniciar a leitura deste livro do início?",
            isPresented: $showResetConfirmation,
            titleVisibility: .visible
        ) {
            Button("Reiniciar do Início", role: .destructive) {
                Task { await reset() }
            }
            Button("Cancelar", role: .cancel) {}
        }
        .task {
            await loadCard()
        }
    }

    private func loadCard() async {
        isLoading = true
        errorMessage = nil
        do {
            let res = try await api.fetchCurrentCard(editionId: editionId)
            withAnimation(.easeInOut(duration: 0.2)) {
                self.title = res.title
                self.author = res.author
                self.currentCard = res.card
                if let s = res.session {
                    self.fragmentIndex = s.currentFragmentIndex + 1
                    self.totalFragments = s.totalFragments
                    self.progressPercent = s.totalFragments > 0 ? Int((Double(s.completedFragmentIndices.count) / Double(s.totalFragments)) * 100) : 0
                }
                self.isLoading = false
            }
            refitDisplayed()
            WidgetSync.reload()
        } catch {
            withAnimation {
                self.errorMessage = "Erro ao carregar livro: \(error.localizedDescription)"
                self.isLoading = false
            }
        }
    }

    private func advance() async {
        guard !isAdvancing else { return }
        isAdvancing = true
        defer { isAdvancing = false }

        feedback.impactOccurred()
        do {
            let res = try await api.advanceCard(editionId: editionId, consumedWordCount: fittedWordCount > 0 ? fittedWordCount : nil)
            withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
                if let next = res.currentCard {
                    self.currentCard = next
                }
                if let s = res.session {
                    self.fragmentIndex = s.currentFragmentIndex + 1
                    self.totalFragments = s.totalFragments
                    self.progressPercent = s.totalFragments > 0 ? Int((Double(s.completedFragmentIndices.count) / Double(s.totalFragments)) * 100) : 0
                }
            }
            refitDisplayed()
            WidgetSync.reload()
        } catch {
            print("Failed to advance card: \(error)")
        }
    }

    private func rewind() async {
        feedback.impactOccurred()
        do {
            let res = try await api.rewindCard(editionId: editionId)
            withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
                if let prev = res.currentCard {
                    self.currentCard = prev
                }
                if let s = res.session {
                    self.fragmentIndex = s.currentFragmentIndex + 1
                    self.totalFragments = s.totalFragments
                    self.progressPercent = s.totalFragments > 0 ? Int((Double(s.completedFragmentIndices.count) / Double(s.totalFragments)) * 100) : 0
                }
            }
            refitDisplayed()
            WidgetSync.reload()
        } catch {
            print("Failed to rewind card: \(error)")
        }
    }

    private func reset() async {
        feedback.impactOccurred()
        do {
            let res = try await api.resetBook(editionId: editionId)
            withAnimation(.easeInOut(duration: 0.25)) {
                self.currentCard = res.card
                if let s = res.session {
                    self.fragmentIndex = s.currentFragmentIndex + 1
                    self.totalFragments = s.totalFragments
                    self.progressPercent = 0
                }
            }
            refitDisplayed()
            WidgetSync.reload()
        } catch {
            print("Failed to reset book: \(error)")
        }
    }

    private func isCompletingFragment(_ card: CardItem) -> Bool {
        if card.isTitleCard == true { return false }
        let remaining = card.wordsUntilFragmentEnd ?? 0
        return remaining > 0 && fittedWordCount >= remaining
    }

    private func refitDisplayed() {
        updateFit(size: cardSize)
    }

    private func updateFit(size: CGSize) {
        cardSize = size
        guard let card = currentCard else { return }
        let box = CGSize(width: max(1, size.width - 40), height: max(1, size.height - 40))
        if card.isTitleCard == true {
            displayedText = card.text
            fittedWordCount = max(1, card.text.split(whereSeparator: \.isWhitespace).filter { !$0.isEmpty }.count)
            return
        }
        let fitted = CardFitter.prefix(
            text: card.text,
            size: box,
            fontSize: CGFloat(fontSize),
            lineSpacing: 6
        )
        displayedText = fitted.text
        fittedWordCount = fitted.wordCount
    }
}
