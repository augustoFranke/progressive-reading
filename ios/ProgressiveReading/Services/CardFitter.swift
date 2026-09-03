import UIKit
import CoreText

public struct FittedCard {
    public let text: String
    public let wordCount: Int
}

public enum CardFitter {
    /// Longest word-prefix of `text` that Core Text can draw inside `size`.
    public static func prefix(
        text: String,
        size: CGSize,
        fontSize: CGFloat,
        lineSpacing: CGFloat
    ) -> FittedCard {
        let words = text.split(whereSeparator: \.isWhitespace).filter { !$0.isEmpty }.map(String.init)
        if words.isEmpty { return FittedCard(text: "", wordCount: 0) }

        let flattened = words.joined(separator: " ")
        let box = CGSize(width: max(1, size.width), height: max(1, size.height))
        let attributed = attributedString(flattened, fontSize: fontSize, lineSpacing: lineSpacing)
        let framesetter = CTFramesetterCreateWithAttributedString(attributed)
        var fitRange = CFRange()
        _ = CTFramesetterSuggestFrameSizeWithConstraints(
            framesetter,
            CFRange(location: 0, length: attributed.length),
            nil,
            box,
            &fitRange
        )

        let utf16Count = min(max(fitRange.length, 0), attributed.length)
        if utf16Count <= 0 {
            return FittedCard(text: words[0], wordCount: 1)
        }

        let raw = (flattened as NSString).substring(to: utf16Count)
        let complete = completeWords(prefix: raw, full: flattened)
        let count = complete.split(whereSeparator: \.isWhitespace).filter { !$0.isEmpty }.count
        if count == 0 { return FittedCard(text: words[0], wordCount: 1) }
        return FittedCard(text: complete, wordCount: count)
    }

    /// Drop a trailing partial word so consume/advance stay on word boundaries.
    private static func completeWords(prefix: String, full: String) -> String {
        let trimmed = prefix.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return "" }
        if prefix.hasSuffix(" ") || trimmed == full { return trimmed }
        guard let lastSpace = trimmed.lastIndex(of: " ") else { return wordsOf(full).first ?? trimmed }
        return String(trimmed[..<lastSpace])
    }

    private static func wordsOf(_ text: String) -> [String] {
        text.split(whereSeparator: \.isWhitespace).filter { !$0.isEmpty }.map(String.init)
    }

    private static func attributedString(_ text: String, fontSize: CGFloat, lineSpacing: CGFloat) -> NSAttributedString {
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineSpacing = lineSpacing
        paragraph.lineBreakMode = .byWordWrapping
        return NSAttributedString(
            string: text,
            attributes: [
                .font: serifFont(size: fontSize),
                .paragraphStyle: paragraph,
            ]
        )
    }

    private static func serifFont(size: CGFloat) -> UIFont {
        let base = UIFont.systemFont(ofSize: size)
        guard let descriptor = base.fontDescriptor.withDesign(.serif) else { return base }
        return UIFont(descriptor: descriptor, size: size)
    }
}
