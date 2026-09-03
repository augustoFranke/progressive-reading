import { flattenCardText, normalizeCardProse, stripLeadingTitle } from "./text.js";

export const DEFAULT_BOX_COLUMNS = 42;
export const DEFAULT_BOX_ROWS = 7;
export const STREAM_WORD_CAP = 800;

export interface WindowPosition {
  fragmentIndex: number;
  wordOffset: number;
  titlePending: boolean;
  cardIndex: number;
}

export interface FragmentBody {
  fragmentId: string;
  title?: string;
  bodyWords: string[];
}

export interface ReadStream {
  text: string;
  words: string[];
  isTitleCard: boolean;
  wordsUntilFragmentEnd: number;
  fragmentId: string;
}

export function emptyPosition(): WindowPosition {
  return { fragmentIndex: 0, wordOffset: 0, titlePending: false, cardIndex: 0 };
}

export function wordsOf(text: string): string[] {
  return flattenCardText(normalizeCardProse(text))
    .split(" ")
    .filter((token) => token.length > 0);
}

export function fragmentBodyFromRendition(renditionText: string, title?: string): string[] {
  const flattened = flattenCardText(normalizeCardProse(renditionText));
  const stripped = title ? stripLeadingTitle(flattened, title) : flattened;
  return wordsOf(stripped);
}

/** Wrap to a character-column box and return how many words fill `rows` lines. */
export function fitWordsToLineBox(
  text: string,
  columns = DEFAULT_BOX_COLUMNS,
  rows = DEFAULT_BOX_ROWS,
): { text: string; wordCount: number } {
  const words = wordsOf(text);
  if (words.length === 0) return { text: "", wordCount: 0 };

  const width = Math.max(1, columns);
  const maxRows = Math.max(1, rows);
  const fitted: string[] = [];
  let line = "";
  let usedRows = 1;

  for (const word of words) {
    const next = line.length === 0 ? word : `${line} ${word}`;
    if (next.length <= width) {
      line = next;
      fitted.push(word);
      continue;
    }
    if (usedRows >= maxRows) break;
    usedRows += 1;
    line = word;
    fitted.push(word);
  }

  return { text: fitted.join(" "), wordCount: fitted.length };
}

export function buildReadStream(fragments: FragmentBody[], position: WindowPosition): ReadStream {
  const current = fragments[position.fragmentIndex];
  if (!current) {
    return { text: "", words: [], isTitleCard: false, wordsUntilFragmentEnd: 0, fragmentId: "" };
  }

  if (position.titlePending && current.title) {
    const titleWords = wordsOf(current.title);
    return {
      text: titleWords.join(" "),
      words: titleWords,
      isTitleCard: true,
      wordsUntilFragmentEnd: Math.max(0, current.bodyWords.length - position.wordOffset),
      fragmentId: current.fragmentId,
    };
  }

  const words: string[] = current.bodyWords.slice(position.wordOffset);
  const wordsUntilFragmentEnd = words.length;

  for (let index = position.fragmentIndex + 1; index < fragments.length && words.length < STREAM_WORD_CAP; index += 1) {
    const next = fragments[index];
    if (next.title) break;
    words.push(...next.bodyWords);
  }

  return {
    text: words.join(" "),
    words,
    isTitleCard: false,
    wordsUntilFragmentEnd,
    fragmentId: current.fragmentId,
  };
}

export function consumeReadStream(
  fragments: FragmentBody[],
  position: WindowPosition,
  wordCount: number,
): { position: WindowPosition; fragmentAdvanced: boolean; completedFragmentIndices: number[] } {
  const completedFragmentIndices: number[] = [];

  if (position.titlePending) {
    return {
      position: {
        ...position,
        titlePending: false,
        cardIndex: position.cardIndex + 1,
      },
      fragmentAdvanced: false,
      completedFragmentIndices,
    };
  }

  let remaining = Math.max(0, Math.floor(wordCount));
  if (remaining <= 0) {
    return { position, fragmentAdvanced: false, completedFragmentIndices };
  }

  let fragmentIndex = position.fragmentIndex;
  let wordOffset = position.wordOffset;
  let fragmentAdvanced = false;
  let titlePending = false;

  while (remaining > 0 && fragmentIndex < fragments.length) {
    const fragment = fragments[fragmentIndex];
    const available = Math.max(0, fragment.bodyWords.length - wordOffset);
    if (available === 0) {
      completedFragmentIndices.push(fragmentIndex);
      fragmentAdvanced = true;
      fragmentIndex += 1;
      wordOffset = 0;
      if (fragmentIndex < fragments.length && fragments[fragmentIndex].title) {
        titlePending = true;
        break;
      }
      continue;
    }

    const take = Math.min(remaining, available);
    wordOffset += take;
    remaining -= take;

    if (wordOffset >= fragment.bodyWords.length) {
      completedFragmentIndices.push(fragmentIndex);
      fragmentAdvanced = true;
      fragmentIndex += 1;
      wordOffset = 0;
      if (fragmentIndex >= fragments.length) break;
      if (fragments[fragmentIndex].title) {
        titlePending = true;
        break;
      }
    }
  }

  const atEnd = fragmentIndex >= fragments.length;
  return {
    position: {
      fragmentIndex: atEnd ? Math.max(0, fragments.length - 1) : fragmentIndex,
      wordOffset: atEnd ? fragments[fragments.length - 1]?.bodyWords.length ?? 0 : wordOffset,
      titlePending: atEnd ? false : titlePending,
      cardIndex: atEnd ? position.cardIndex + 1 : titlePending ? 0 : position.cardIndex + 1,
    },
    fragmentAdvanced,
    completedFragmentIndices,
  };
}
