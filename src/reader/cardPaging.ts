import type { CardPagingOptions, WidgetCard } from "./types.js";
import { flattenCardText, normalizeCardProse, stripLeadingTitle } from "./text.js";

export { flattenCardText, normalizeCardProse } from "./text.js";

/**
 * Character budget for systemMedium (4x2) at the widget serif size.
 * 220 left about 1⅔ empty lines on device; 290 fills those lines
 * (~42 chars/line) and still leaves a little width margin.
 */
const DEFAULT_MAX_CHARS = 290;
const AVG_CHARS_PER_WORD = 6;
const DEFAULT_WPM = 220;

export function splitFragmentIntoCards(
  fragmentText: string,
  fragmentId: string,
  options: CardPagingOptions = {},
): WidgetCard[] {
  const maxChars =
    options.maxCharactersPerCard ??
    (options.maxWordsPerCard != null
      ? options.maxWordsPerCard * AVG_CHARS_PER_WORD
      : DEFAULT_MAX_CHARS);
  const wpm = options.wordsPerMinute ?? DEFAULT_WPM;
  const leadingTitle = options.leadingTitle ? flattenCardText(options.leadingTitle) : "";

  let body = flattenCardText(normalizeCardProse(fragmentText));
  if (leadingTitle) {
    body = stripLeadingTitle(body, leadingTitle);
  }

  if (!body && !leadingTitle) {
    return [
      {
        cardIndex: 0,
        totalCards: 1,
        fragmentId,
        text: "",
        wordCount: 0,
        estimatedReadSeconds: 5,
        isFinalCardOfFragment: true,
      },
    ];
  }

  const bodyCards = body ? splitToCharacterBudget(body, maxChars) : [];
  const cardsText = leadingTitle ? [leadingTitle, ...bodyCards] : bodyCards;
  const totalCards = cardsText.length;
  return cardsText.map((text, index) => {
    const wordCount = countWords(text);
    return {
      cardIndex: index,
      totalCards,
      fragmentId,
      text,
      wordCount,
      estimatedReadSeconds: Math.max(5, Math.round((wordCount / wpm) * 60)),
      isFinalCardOfFragment: index === totalCards - 1,
    };
  });
}

function splitToCharacterBudget(text: string, maxChars: number): string[] {
  const budget = Math.max(1, maxChars);
  const cards: string[] = [];
  let remaining = text;

  while (remaining.length > budget) {
    const cut = findWordBoundaryCut(remaining, budget);
    cards.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }

  if (remaining.length > 0) {
    cards.push(remaining);
  }

  return cards.length > 0 ? cards : [""];
}

/** Fill up to budget; break on the last space so words stay intact. */
function findWordBoundaryCut(text: string, budget: number): number {
  if (text.length <= budget) return text.length;
  if (text.charAt(budget) === " " || text.charAt(budget - 1) === " ") {
    return budget;
  }
  const lastSpace = text.lastIndexOf(" ", budget);
  return lastSpace > 0 ? lastSpace : budget;
}

function countWords(text: string): number {
  const tokens = text.trim().split(/\s+/u).filter((t) => t.length > 0);
  return tokens.length;
}
