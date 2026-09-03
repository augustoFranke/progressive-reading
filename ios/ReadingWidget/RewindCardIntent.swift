import AppIntents
import WidgetKit

@available(iOS 17.0, *)
public struct RewindCardIntent: AppIntent {
    public static var title: LocalizedStringResource = "Voltar Trecho de Leitura"
    public static var description = IntentDescription("Retorna para o trecho anterior do livro no widget.")
    public static var openAppWhenRun: Bool = false

    @Parameter(title: "Book ID")
    var bookId: String

    public init() {
        self.bookId = ""
    }

    public init(bookId: String) {
        self.bookId = bookId
    }

    public func perform() async throws -> some IntentResult {
        let id = bookId.isEmpty ? nil : bookId
        try await ReadingAPIService.shared.rewindWidget(bookId: id)
        WidgetCenter.shared.reloadAllTimelines()
        return .result()
    }
}
