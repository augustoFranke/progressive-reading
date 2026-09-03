import AppIntents

struct BookEntity: AppEntity {
    static var typeDisplayRepresentation = TypeDisplayRepresentation(name: "Livro")
    static var defaultQuery = BookEntityQuery()

    var id: String
    var title: String

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(title)")
    }
}

struct BookEntityQuery: EntityQuery, EntityStringQuery {
    func entities(for identifiers: [BookEntity.ID]) async throws -> [BookEntity] {
        let books = try await ReadingAPIService.shared.fetchBooks()
        return books
            .filter { identifiers.contains($0.id) }
            .map { BookEntity(id: $0.id, title: $0.title) }
    }

    func suggestedEntities() async throws -> [BookEntity] {
        let books = try await ReadingAPIService.shared.fetchBooks()
        return books.map { BookEntity(id: $0.id, title: $0.title) }
    }

    func entities(matching string: String) async throws -> [BookEntity] {
        let books = try await ReadingAPIService.shared.fetchBooks()
        if string.isEmpty {
            return books.map { BookEntity(id: $0.id, title: $0.title) }
        }
        return books
            .filter { $0.title.localizedCaseInsensitiveContains(string) }
            .map { BookEntity(id: $0.id, title: $0.title) }
    }
}
