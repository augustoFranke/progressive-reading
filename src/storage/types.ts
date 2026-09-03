import type { Edition } from "../core/types.js";
import type { GeneratedFragment } from "../generate/types.js";

export interface StoredFragmentRecord {
  editionId: string;
  fragmentIndex: number;
  fragmentId: string;
  generated: GeneratedFragment;
  storedAt: string;
}

export interface WindowHistoryEntry {
  fragmentIndex: number;
  wordOffset: number;
  titlePending: boolean;
  cardIndex: number;
}

export interface ReaderSession {
  editionId: string;
  title: string;
  currentFragmentIndex: number;
  currentCardIndex: number;
  totalFragments: number;
  completedFragmentIndices: number[];
  lastReadAt: string;
  activeContinuityNote?: string;
  /** Word offset into the current fragment body after any chapter title card. */
  currentWordOffset?: number;
  titlePending?: boolean;
  windowHistory?: WindowHistoryEntry[];
}
