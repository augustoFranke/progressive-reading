import Foundation

/// Errors surfaced to the UI with a readable message, including the message the
/// server itself sent back in its `{ "error": ... }` payload.
public enum APIError: LocalizedError {
    case invalidServerURL(String)
    case notHTTP
    case server(status: Int, message: String?)
    case decoding(Error)
    case unreadableFile(String)

    public var errorDescription: String? {
        switch self {
        case .invalidServerURL(let raw):
            return "Endereço do servidor inválido: \(raw)"
        case .notHTTP:
            return "O servidor respondeu em um formato inesperado."
        case .server(let status, let message):
            if let message, !message.isEmpty { return message }
            switch status {
            case 404: return "Endereço não encontrado no servidor (404)."
            case 413: return "Arquivo grande demais para o servidor (413)."
            case 415, 422: return "O servidor não conseguiu ler este arquivo EPUB (\(status))."
            case 500...599: return "Erro interno do servidor (\(status))."
            default: return "O servidor respondeu com erro \(status)."
            }
        case .decoding:
            return "Resposta do servidor em formato inesperado."
        case .unreadableFile(let reason):
            return reason
        }
    }
}

public struct HealthStatus: Codable {
    public let status: String
    public let provider: String?
    public let judge: String?
}

public final class ReadingAPIService {
    public static let shared = ReadingAPIService()

    public static let defaultServerURLString = "https://pc-ubuntu-server.tailaaf7d0.ts.net:8446"
    private static let serverURLDefaultsKey = "customServerURL"
    private static let retiredServerURLs: Set<String> = [
        "https://supplier-syntax-telecom-instruments.trycloudflare.com"
    ]

    /// The configured server address. Tunnel URLs rotate, so this is user-editable
    /// in the app instead of being frozen at build time.
    public var serverURLString: String {
        get {
            let stored = UserDefaults.standard.string(forKey: Self.serverURLDefaultsKey)?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            guard let stored, !stored.isEmpty else { return Self.defaultServerURLString }
            if Self.retiredServerURLs.contains(Self.normalize(stored)) {
                UserDefaults.standard.removeObject(forKey: Self.serverURLDefaultsKey)
                return Self.defaultServerURLString
            }
            return stored
        }
        set {
            let normalized = Self.normalize(newValue)
            if normalized.isEmpty {
                UserDefaults.standard.removeObject(forKey: Self.serverURLDefaultsKey)
            } else {
                UserDefaults.standard.set(normalized, forKey: Self.serverURLDefaultsKey)
            }
        }
    }

    public var baseURL: URL {
        URL(string: serverURLString) ?? URL(string: Self.defaultServerURLString)!
    }

    /// Accepts `host.example.com` as well as a full URL, and drops a trailing slash.
    public static func normalize(_ raw: String) -> String {
        var value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return "" }
        if !value.lowercased().hasPrefix("http://") && !value.lowercased().hasPrefix("https://") {
            value = "https://" + value
        }
        while value.hasSuffix("/") { value.removeLast() }
        return value
    }

    public static func isValid(_ raw: String) -> Bool {
        guard let url = URL(string: normalize(raw)) else { return false }
        return url.host?.isEmpty == false
    }

    private let session: URLSession

    public init(session: URLSession? = nil) {
        if let s = session {
            self.session = s
        } else {
            let config = URLSessionConfiguration.default
            config.timeoutIntervalForRequest = 20
            config.timeoutIntervalForResource = 60
            // A dead quick-tunnel hostname must fail visibly instead of leaving the
            // import overlay waiting for iOS connectivity recovery for minutes.
            config.waitsForConnectivity = false
            config.requestCachePolicy = .reloadIgnoringLocalCacheData
            self.session = URLSession(configuration: config)
        }
    }

    public func checkHealth() async throws -> HealthStatus {
        try await get(HealthStatus.self, path: "api/health", timeout: 12)
    }

    /// Cover art URL for a book, or nil when the server reported it has none —
    /// nil keeps the row from firing a request that can only 404.
    public func coverURL(for book: BookSummary) -> URL? {
        guard book.hasCover == true else { return nil }
        guard let base = URL(string: serverURLString) else { return nil }
        return base
            .appendingPathComponent("api")
            .appendingPathComponent("books")
            .appendingPathComponent(book.id)
            .appendingPathComponent("cover")
    }

    public func fetchBooks() async throws -> [BookSummary] {
        try await get(BooksListResponse.self, path: "api/books").books
    }

    public func fetchCurrentCard(editionId: String) async throws -> BookCardResponse {
        try await get(BookCardResponse.self, path: "api/books/\(pathSafe(editionId))/card")
    }

    public func advanceCard(editionId: String, consumedWordCount: Int? = nil) async throws -> AdvanceResponse {
        var body: [String: Any] = [:]
        if let consumedWordCount { body["consumedWordCount"] = consumedWordCount }
        return try await post(AdvanceResponse.self, path: "api/books/\(pathSafe(editionId))/advance", body: body)
    }

    public func rewindCard(editionId: String) async throws -> RewindResponse {
        try await post(RewindResponse.self, path: "api/books/\(pathSafe(editionId))/rewind")
    }

    public func resetBook(editionId: String) async throws -> BookCardResponse {
        try await post(BookCardResponse.self, path: "api/books/\(pathSafe(editionId))/reset")
    }

    /// Streams the EPUB body with an upload task and a long timeout: ingest happens
    /// server-side before the response, and the file can be several megabytes.
    public func uploadEPUB(data: Data, filename: String? = nil) async throws -> BookSummary {
        // Verify the exact backend immediately before sending a potentially large file.
        // This distinguishes an unavailable/expired tunnel from an EPUB ingest error.
        _ = try await checkHealth()

        var request = URLRequest(url: baseURL.appendingPathComponent("api/books/upload"))
        request.httpMethod = "POST"
        request.setValue("application/epub+zip", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 60
        if let filename, let encoded = filename.addingPercentEncoding(withAllowedCharacters: .alphanumerics) {
            request.setValue(encoded, forHTTPHeaderField: "X-File-Name")
        }

        let (respData, response) = try await session.upload(for: request, from: data)
        return try decode(BookSummary.self, from: respData, response: response)
    }

    public func fetchWidgetCurrent(bookId: String? = nil) async throws -> WidgetCardPayload {
        var components = URLComponents(
            url: baseURL.appendingPathComponent("api/widget/current"),
            resolvingAgainstBaseURL: false
        )!
        if let bookId, !bookId.isEmpty {
            components.queryItems = [URLQueryItem(name: "bookId", value: bookId)]
        }
        guard let url = components.url else {
            throw APIError.invalidServerURL(serverURLString)
        }
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        let (data, response) = try await session.data(for: request)
        return try decode(WidgetCardPayload.self, from: data, response: response)
    }

    public func advanceWidget(bookId: String? = nil, consumedWordCount: Int? = nil) async throws -> AdvanceResponse {
        var body: [String: Any] = [:]
        if let bookId { body["bookId"] = bookId }
        if let consumedWordCount { body["consumedWordCount"] = consumedWordCount }
        return try await post(AdvanceResponse.self, path: "api/widget/advance", body: body)
    }

    public func rewindWidget(bookId: String? = nil) async throws -> RewindResponse {
        try await post(RewindResponse.self, path: "api/widget/rewind", body: bookId.map { ["bookId": $0] } ?? [:])
    }

    // MARK: - Transport

    private func get<T: Decodable>(_ type: T.Type, path: String, timeout: TimeInterval? = nil) async throws -> T {
        var request = URLRequest(url: baseURL.appendingPathComponent(path))
        request.httpMethod = "GET"
        if let timeout { request.timeoutInterval = timeout }
        let (data, response) = try await session.data(for: request)
        return try decode(type, from: data, response: response)
    }

    private func post<T: Decodable>(
        _ type: T.Type,
        path: String,
        body: [String: Any]? = nil
    ) async throws -> T {
        var request = URLRequest(url: baseURL.appendingPathComponent(path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let body, !body.isEmpty {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, response) = try await session.data(for: request)
        return try decode(type, from: data, response: response)
    }

    private func decode<T: Decodable>(_ type: T.Type, from data: Data, response: URLResponse) throws -> T {
        guard let http = response as? HTTPURLResponse else { throw APIError.notHTTP }
        guard (200...299).contains(http.statusCode) else {
            throw APIError.server(status: http.statusCode, message: Self.serverMessage(from: data))
        }
        do {
            return try JSONDecoder().decode(type, from: data)
        } catch {
            throw APIError.decoding(error)
        }
    }

    private static func serverMessage(from data: Data) -> String? {
        struct ErrorEnvelope: Decodable { let error: String? }
        return (try? JSONDecoder().decode(ErrorEnvelope.self, from: data))?.error
    }

    private func pathSafe(_ component: String) -> String {
        component.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? component
    }
}
