import AppIntents

struct SelectBookIntent: WidgetConfigurationIntent {
    static var title: LocalizedStringResource = "Selecionar livro"
    static var description = IntentDescription("Escolha qual livro exibir no widget.")

    @Parameter(title: "Livro")
    var book: BookEntity?
}
