import WidgetKit
import SwiftUI
import AppIntents

struct ReadingEntry: TimelineEntry {
    let date: Date
    let payload: WidgetCardPayload
}

struct ReadingProvider: AppIntentTimelineProvider {
    typealias Entry = ReadingEntry
    typealias Intent = SelectBookIntent

    func placeholder(in context: Context) -> ReadingEntry {
        ReadingEntry(date: Date(), payload: .placeholder)
    }

    func snapshot(for configuration: SelectBookIntent, in context: Context) async -> ReadingEntry {
        let bookId = configuration.book?.id
        let payload = (try? await ReadingAPIService.shared.fetchWidgetCurrent(bookId: bookId)) ?? .placeholder
        return ReadingEntry(date: Date(), payload: payload)
    }

    func timeline(for configuration: SelectBookIntent, in context: Context) async -> Timeline<ReadingEntry> {
        let bookId = configuration.book?.id
        let payload = (try? await ReadingAPIService.shared.fetchWidgetCurrent(bookId: bookId)) ?? .placeholder
        let entry = ReadingEntry(date: Date(), payload: payload)
        let nextUpdate = Calendar.current.date(byAdding: .minute, value: 15, to: Date())!
        let timeline = Timeline(entries: [entry], policy: .after(nextUpdate))
        return timeline
    }
}

struct ReadingWidgetEntryView: View {
    @Environment(\.widgetFamily) var family
    var entry: ReadingProvider.Entry

    var body: some View {
        if !entry.payload.hasBook {
            EmptyWidgetView()
        } else {
            switch family {
            case .systemSmall:
                SmallWidgetView(payload: entry.payload)
            case .systemMedium:
                MediumWidgetView(payload: entry.payload)
            case .systemLarge:
                LargeWidgetView(payload: entry.payload)
            case .accessoryRectangular:
                LockScreenWidgetView(payload: entry.payload)
            default:
                MediumWidgetView(payload: entry.payload)
            }
        }
    }
}

struct SmallWidgetView: View {
    let payload: WidgetCardPayload

    var body: some View {
        WidgetReadingLayout(
            payload: payload,
            textSize: 10.5,
            lineSpacing: 1,
            titleSize: 9,
            metricsSize: 8
        )
    }
}

struct MediumWidgetView: View {
    let payload: WidgetCardPayload

    var body: some View {
        WidgetReadingLayout(
            payload: payload,
            textSize: 12,
            lineSpacing: 2,
            titleSize: 10,
            metricsSize: 9
        )
    }
}

struct LargeWidgetView: View {
    let payload: WidgetCardPayload

    var body: some View {
        WidgetReadingLayout(
            payload: payload,
            textSize: 13.5,
            lineSpacing: 3,
            titleSize: 11,
            metricsSize: 9.5
        )
    }
}

/// Widget prose is one continuous block so lines fill width; paragraph breaks are flattened.
private func flattenWidgetText(_ text: String) -> String {
    text.split(whereSeparator: \.isWhitespace)
        .filter { !$0.isEmpty }
        .joined(separator: " ")
}

/// Fragment fills the widget and doubles as the navigation surface: tapping the left half
/// rewinds a card, tapping the right half advances. One bottom chrome row holds metadata only.
private struct WidgetReadingLayout: View {
    let payload: WidgetCardPayload
    var textSize: CGFloat
    var lineSpacing: CGFloat
    var titleSize: CGFloat
    var metricsSize: CGFloat

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            GeometryReader { geo in
                let source = flattenWidgetText(payload.text)
                let fitted = payload.isTitleCard
                    ? FittedCard(text: source, wordCount: 0)
                    : CardFitter.prefix(
                        text: source,
                        size: geo.size,
                        fontSize: textSize,
                        lineSpacing: lineSpacing
                    )
                let shown = payload.isTitleCard ? source : fitted.text
                Text(shown)
                    .font(.system(size: textSize, design: .serif))
                    .lineSpacing(lineSpacing)
                    .foregroundStyle(.primary)
                    .frame(width: geo.size.width, height: geo.size.height, alignment: .topLeading)
                    .clipped()
                    .overlay {
                        if #available(iOS 17.0, *) {
                            HStack(spacing: 0) {
                                Button(intent: RewindCardIntent(bookId: payload.editionId)) {
                                    Color.clear
                                        .contentShape(Rectangle())
                                }
                                .buttonStyle(.plain)
                                .accessibilityLabel("Voltar")

                                Button(intent: AdvanceCardIntent(
                                    bookId: payload.editionId,
                                    consumedWordCount: payload.isTitleCard ? 0 : fitted.wordCount
                                )) {
                                    Color.clear
                                        .contentShape(Rectangle())
                                }
                                .buttonStyle(.plain)
                                .accessibilityLabel(
                                    !payload.isTitleCard && payload.wordsUntilFragmentEnd > 0 && fitted.wordCount >= payload.wordsUntilFragmentEnd
                                        ? "Concluir"
                                        : "Avançar"
                                )
                            }
                        }
                    }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

            WidgetChromeBar(
                payload: payload,
                titleSize: titleSize,
                metricsSize: metricsSize
            )
        }
        .containerBackground(for: .widget) {
            WidgetSurface()
        }
    }
}

/// Widget surface mirrors the app icon's backgrounds so the two read as one product on the
/// Home Screen. Light is flat white; dark is the vertical gradient measured off the system
/// dark-icon convention (#212121 top -> #0D0D0D bottom), not a flat gray.
private struct WidgetSurface: View {
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        if colorScheme == .dark {
            LinearGradient(
                colors: [
                    Color(.sRGB, white: 33.0 / 255.0, opacity: 1),
                    Color(.sRGB, white: 13.0 / 255.0, opacity: 1)
                ],
                startPoint: .top,
                endPoint: .bottom
            )
        } else {
            Color(.sRGB, white: 1, opacity: 1)
        }
    }
}

private struct WidgetChromeBar: View {
    let payload: WidgetCardPayload
    var titleSize: CGFloat
    var metricsSize: CGFloat

    private var metrics: String {
        "F\(payload.fragmentIndex)/\(payload.totalFragments) · C\(payload.cardIndex)/\(payload.totalCards) · \(payload.progressPercent)% · ~\(payload.estimatedReadSeconds)s"
    }

    var body: some View {
        HStack(spacing: 4) {
            VStack(alignment: .leading, spacing: 0) {
                Text(payload.title)
                    .font(.system(size: titleSize, weight: .bold))
                    .lineLimit(1)
                Text(metrics)
                    .font(.system(size: metricsSize, weight: .medium))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            .minimumScaleFactor(0.8)

            Spacer(minLength: 2)
        }
    }
}

struct LockScreenWidgetView: View {
    let payload: WidgetCardPayload

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack {
                Text(payload.title)
                    .font(.system(size: 10, weight: .bold))
                    .lineLimit(1)
                Spacer()
                Text("[\(payload.cardIndex)/\(payload.totalCards)]")
                    .font(.system(size: 8.5))
            }
            Text(flattenWidgetText(payload.text))
                .font(.system(size: 10, design: .serif))
                .lineLimit(3)
        }
    }
}

struct EmptyWidgetView: View {
    var body: some View {
        VStack(spacing: 4) {
            Image(systemName: "book.closed")
                .font(.title3)
                .foregroundStyle(.secondary)
            Text("Nenhum livro ativo")
                .font(.caption.bold())
            Text("Abra o app para ler")
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .containerBackground(for: .widget) {
            WidgetSurface()
        }
    }
}

@main
struct ReadingWidget: Widget {
    let kind: String = "ReadingWidget"

    var body: some WidgetConfiguration {
        AppIntentConfiguration(kind: kind, intent: SelectBookIntent.self, provider: ReadingProvider()) { entry in
            ReadingWidgetEntryView(entry: entry)
        }
        .configurationDisplayName("Leitura Progressiva")
        .description("Leia livros clássicos em micro-momentos diretamente na sua tela inicial.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge, .accessoryRectangular])
    }
}
