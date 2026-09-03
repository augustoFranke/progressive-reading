import AppIntents
import WidgetKit

@available(iOS 17.0, *)
public struct AdvanceCardIntent: AppIntent {
    public static var title: LocalizedStringResource = "Avançar Trecho de Leitura"
    public static var description = IntentDescription("Avança para o próximo trecho do livro no widget.")
    public static var openAppWhenRun: Bool = false

    @Parameter(title: "Book ID")
    var bookId: String

    @Parameter(title: "Consumed Word Count")
    var consumedWordCount: Int

    public init() {
        self.bookId = ""
        self.consumedWordCount = 0
    }

    public init(bookId: String, consumedWordCount: Int = 0) {
        self.bookId = bookId
        self.consumedWordCount = consumedWordCount
    }

    public func perform() async throws -> some IntentResult {
        let id = bookId.isEmpty ? nil : bookId
        let consumed = consumedWordCount > 0 ? consumedWordCount : nil
        try await ReadingAPIService.shared.advanceWidget(bookId: id, consumedWordCount: consumed)
        WidgetCenter.shared.reloadAllTimelines()
        return .result()
    }
}
