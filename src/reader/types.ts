export interface WidgetCard {
  cardIndex: number;
  totalCards: number;
  fragmentId: string;
  text: string;
  wordCount: number;
  estimatedReadSeconds: number;
  isFinalCardOfFragment: boolean;
  /** Words left in the current fragment body from this window. Used by the client fitter. */
  wordsUntilFragmentEnd?: number;
  isTitleCard?: boolean;
}

export interface CardPagingOptions {
  /** Visible character budget for a 4x2 widget card, including spaces. */
  maxCharactersPerCard?: number;
  /** Optional word cap; used only when maxCharactersPerCard is omitted. */
  maxWordsPerCard?: number;
  minWordsPerCard?: number;
  targetWordsPerCard?: number;
  wordsPerMinute?: number;
  /** Chapter heading shown as its own first card when a fragment opens a chapter. */
  leadingTitle?: string;
  /** Words the client actually displayed; advances the read window by this much. */
  consumedWordCount?: number;
}
