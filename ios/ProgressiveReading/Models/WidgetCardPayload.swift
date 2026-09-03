import Foundation

public struct WidgetCardPayload: Codable, Identifiable {
    public var id: String { "\(editionId)_\(fragmentIndex)_\(cardIndex)" }
    public let hasBook: Bool
    public let editionId: String
    public let title: String
    public let author: String?
    public let fragmentIndex: Int
    public let totalFragments: Int
    public let cardIndex: Int
    public let totalCards: Int
    public let progressPercent: Int
    public let text: String
    public let estimatedReadSeconds: Int
    public let isFinalCardOfFragment: Bool
    public let wordsUntilFragmentEnd: Int
    public let isTitleCard: Bool

    public init(
        hasBook: Bool,
        editionId: String,
        title: String,
        author: String?,
        fragmentIndex: Int,
        totalFragments: Int,
        cardIndex: Int,
        totalCards: Int,
        progressPercent: Int,
        text: String,
        estimatedReadSeconds: Int,
        isFinalCardOfFragment: Bool,
        wordsUntilFragmentEnd: Int = 0,
        isTitleCard: Bool = false
    ) {
        self.hasBook = hasBook
        self.editionId = editionId
        self.title = title
        self.author = author
        self.fragmentIndex = fragmentIndex
        self.totalFragments = totalFragments
        self.cardIndex = cardIndex
        self.totalCards = totalCards
        self.progressPercent = progressPercent
        self.text = text
        self.estimatedReadSeconds = estimatedReadSeconds
        self.isFinalCardOfFragment = isFinalCardOfFragment
        self.wordsUntilFragmentEnd = wordsUntilFragmentEnd
        self.isTitleCard = isTitleCard
    }

    /// The server answers `{ "hasBook": false }` with no card fields when the library
    /// is empty, so every reading field decodes with a fallback.
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        hasBook = try container.decodeIfPresent(Bool.self, forKey: .hasBook) ?? false
        editionId = try container.decodeIfPresent(String.self, forKey: .editionId) ?? ""
        title = try container.decodeIfPresent(String.self, forKey: .title) ?? ""
        author = try container.decodeIfPresent(String.self, forKey: .author)
        fragmentIndex = try container.decodeIfPresent(Int.self, forKey: .fragmentIndex) ?? 0
        totalFragments = try container.decodeIfPresent(Int.self, forKey: .totalFragments) ?? 0
        cardIndex = try container.decodeIfPresent(Int.self, forKey: .cardIndex) ?? 0
        totalCards = try container.decodeIfPresent(Int.self, forKey: .totalCards) ?? 0
        progressPercent = try container.decodeIfPresent(Int.self, forKey: .progressPercent) ?? 0
        text = try container.decodeIfPresent(String.self, forKey: .text) ?? ""
        estimatedReadSeconds = try container.decodeIfPresent(Int.self, forKey: .estimatedReadSeconds) ?? 0
        isFinalCardOfFragment = try container.decodeIfPresent(Bool.self, forKey: .isFinalCardOfFragment) ?? false
        wordsUntilFragmentEnd = try container.decodeIfPresent(Int.self, forKey: .wordsUntilFragmentEnd) ?? 0
        isTitleCard = try container.decodeIfPresent(Bool.self, forKey: .isTitleCard) ?? false
    }

    public func displaying(text: String, wordCount: Int) -> WidgetCardPayload {
        let seconds = max(5, Int((Double(wordCount) / 220.0) * 60.0))
        let isFinal = !isTitleCard && wordsUntilFragmentEnd > 0 && wordCount >= wordsUntilFragmentEnd
        return WidgetCardPayload(
            hasBook: hasBook,
            editionId: editionId,
            title: title,
            author: author,
            fragmentIndex: fragmentIndex,
            totalFragments: totalFragments,
            cardIndex: cardIndex,
            totalCards: totalCards,
            progressPercent: progressPercent,
            text: text,
            estimatedReadSeconds: seconds,
            isFinalCardOfFragment: isFinal,
            wordsUntilFragmentEnd: wordsUntilFragmentEnd,
            isTitleCard: isTitleCard
        )
    }

    public static let placeholder = WidgetCardPayload(
        hasBook: true,
        editionId: "Blood_Meridian",
        title: "Blood Meridian",
        author: "Cormac McCarthy",
        fragmentIndex: 1,
        totalFragments: 94,
        cardIndex: 1,
        totalCards: 4,
        progressPercent: 5,
        text: "See the child. He is pale and thin, he stokes the scullery fire in Tennessee. Outside lie dark turned fields and woods harboring the last wolves.",
        estimatedReadSeconds: 15,
        isFinalCardOfFragment: false,
        wordsUntilFragmentEnd: 24,
        isTitleCard: false
    )
}

public struct ReaderSessionModel: Codable {
    public let editionId: String
    public let title: String
    public let currentFragmentIndex: Int
    public let currentCardIndex: Int
    public let totalFragments: Int
    public let completedFragmentIndices: [Int]
    public let lastReadAt: String?
}

public struct BookSummary: Codable, Identifiable {
    public let id: String
    public let title: String
    public let author: String?
    public let totalFragments: Int?
    public let completedFragments: Int?
    public let percentCompleted: Int?
    public let lastReadAt: String?
    /// Optional so a server predating cover support still decodes.
    public let hasCover: Bool?

    public var total: Int { totalFragments ?? 1 }
    public var completed: Int { completedFragments ?? 0 }
    public var percent: Int { percentCompleted ?? 0 }
}

public struct BooksListResponse: Codable {
    public let books: [BookSummary]
}

public struct AdvanceResponse: Codable {
    public let editionId: String
    public let title: String
    public let session: ReaderSessionModel?
    public let currentCard: CardItem?
    public let fragmentAdvanced: Bool?
}

public struct RewindResponse: Codable {
    public let editionId: String
    public let title: String
    public let session: ReaderSessionModel?
    public let currentCard: CardItem?
    public let fragmentRewound: Bool?
}

public struct CardItem: Codable {
    public let cardIndex: Int
    public let totalCards: Int
    public let fragmentId: String
    public let text: String
    public let wordCount: Int
    public let estimatedReadSeconds: Int
    public let isFinalCardOfFragment: Bool
    public let wordsUntilFragmentEnd: Int?
    public let isTitleCard: Bool?
}

public struct BookCardResponse: Codable {
    public let editionId: String
    public let title: String
    public let author: String?
    public let session: ReaderSessionModel?
    public let card: CardItem
}
