import type { Edition } from "../core/types.js";
import { generateFragment } from "../generate/generateFragment.js";
import { LocalDraftProvider } from "../generate/localProvider.js";
import type { GeneratedFragment, GenerationProvider, QualityJudge } from "../generate/types.js";
import { extractLeadingChapterTitle } from "../reader/chapterTitle.js";
import type { CardPagingOptions, WidgetCard } from "../reader/types.js";
import {
  buildReadStream,
  consumeReadStream,
  fitWordsToLineBox,
  fragmentBodyFromRendition,
  type FragmentBody,
  type WindowPosition,
} from "../reader/readWindow.js";
import { EditionStorage, getEditionId } from "../storage/cache.js";
import type { ReaderSession, WindowHistoryEntry } from "../storage/types.js";

export interface BufferEngineOptions {
  storage?: EditionStorage;
  provider?: GenerationProvider;
  judge?: QualityJudge;
  defaultBufferSize?: number;
}

export class BufferEngine {
  readonly storage: EditionStorage;
  readonly provider: GenerationProvider;
  readonly judge?: QualityJudge;
  readonly defaultBufferSize: number;
  private readonly activeJobs = new Map<string, Promise<GeneratedFragment>>();

  constructor(options: BufferEngineOptions = {}) {
    this.storage = options.storage ?? new EditionStorage();
    this.provider = options.provider ?? new LocalDraftProvider();
    this.judge = options.judge;
    this.defaultBufferSize = options.defaultBufferSize ?? 3;
  }

  async initializeSession(edition: Edition, prefetchCount = this.defaultBufferSize): Promise<ReaderSession> {
    const editionId = getEditionId(edition);
    // Editions are multi-megabyte documents; rewriting one on every card request
    // stalls the event loop for every other in-flight request.
    if (!(await this.storage.hasEdition(editionId))) {
      await this.storage.saveEdition(edition, editionId);
    }

    let session = await this.storage.getSession(editionId);
    if (!session) {
      session = {
        editionId,
        title: edition.metadata.title,
        currentFragmentIndex: 0,
        currentCardIndex: 0,
        currentWordOffset: 0,
        titlePending: false,
        windowHistory: [],
        totalFragments: edition.fragments.length,
        completedFragmentIndices: [],
        lastReadAt: new Date().toISOString(),
      };
      await this.storage.saveSession(session);
    } else if (
      session.totalFragments !== edition.fragments.length ||
      session.currentFragmentIndex >= edition.fragments.length
    ) {
      // Re-importing a book can change its fragment plan; keep stored progress in range
      // instead of letting getOrGenerateFragment throw an out-of-bounds error.
      session.totalFragments = edition.fragments.length;
      session.currentFragmentIndex = Math.min(
        session.currentFragmentIndex,
        Math.max(0, edition.fragments.length - 1),
      );
      session.currentCardIndex = 0;
      session.currentWordOffset = 0;
      session.titlePending = false;
      session.windowHistory = [];
      session.completedFragmentIndices = session.completedFragmentIndices.filter(
        (index) => index < edition.fragments.length,
      );
      await this.storage.saveSession(session);
    }

    // Trigger non-blocking background prefetch
    void this.prefetchRange(edition, session.currentFragmentIndex, prefetchCount);

    return session;
  }

  async getCurrentFragment(edition: Edition): Promise<GeneratedFragment> {
    const session = await this.initializeSession(edition);
    return this.getOrGenerateFragment(edition, session.currentFragmentIndex, session.activeContinuityNote);
  }

  async getCurrentCard(edition: Edition, options?: CardPagingOptions): Promise<WidgetCard> {
    const session = await this.initializeSession(edition);
    const { card } = await this.readWindow(edition, session);
    return card;
  }

  async confirmAndAdvanceCard(
    edition: Edition,
    options?: CardPagingOptions,
    bufferSize = this.defaultBufferSize,
  ): Promise<{ session: ReaderSession; currentCard: WidgetCard | null; fragmentAdvanced: boolean }> {
    const editionId = getEditionId(edition);
    let session = await this.storage.getSession(editionId);
    if (!session) {
      session = await this.initializeSession(edition);
    }

    const { stream, local, sliceStart, bodies } = await this.readWindow(edition, session);
    if (!stream.text && session.currentFragmentIndex >= edition.fragments.length - 1 && !session.titlePending) {
      return { session, currentCard: null, fragmentAdvanced: true };
    }

    this.pushWindowHistory(session);
    const previousFragment = session.currentFragmentIndex;
    const requested = options?.consumedWordCount;
    const consumed = stream.isTitleCard
      ? 0
      : requested && requested > 0
        ? requested
        : fitWordsToLineBox(stream.text).wordCount;
    const result = consumeReadStream(bodies, local, consumed);

    this.applyWindowPosition(session, sliceStart, result.position, result.completedFragmentIndices);
    session.lastReadAt = new Date().toISOString();

    if (result.fragmentAdvanced) {
      const completed = result.completedFragmentIndices.at(-1);
      if (completed !== undefined) {
        const done = await this.storage.getFragment(editionId, sliceStart + completed);
        if (done?.rendition.continuityNote) {
          session.activeContinuityNote = done.rendition.continuityNote;
        }
      }
      void this.prefetchRange(edition, session.currentFragmentIndex + 1, bufferSize);
    }

    await this.storage.saveSession(session);

    if (session.currentFragmentIndex >= edition.fragments.length) {
      return { session, currentCard: null, fragmentAdvanced: true };
    }

    const next = await this.readWindow(edition, session);
    return {
      session,
      currentCard: next.card,
      fragmentAdvanced: result.fragmentAdvanced || session.currentFragmentIndex !== previousFragment,
    };
  }

  async rewindCard(
    edition: Edition,
    options?: CardPagingOptions,
  ): Promise<{ session: ReaderSession; currentCard: WidgetCard | null; fragmentRewound: boolean }> {
    const editionId = getEditionId(edition);
    let session = await this.storage.getSession(editionId);
    if (!session) {
      session = await this.initializeSession(edition);
    }

    const history = session.windowHistory ?? [];
    if (history.length > 0) {
      const previous = history.pop()!;
      session.windowHistory = history;
      const fragmentRewound = previous.fragmentIndex !== session.currentFragmentIndex;
      session.currentFragmentIndex = previous.fragmentIndex;
      session.currentWordOffset = previous.wordOffset;
      session.titlePending = previous.titlePending;
      session.currentCardIndex = previous.cardIndex;
      if (fragmentRewound) {
        session.completedFragmentIndices = session.completedFragmentIndices.filter(
          (index) => index !== previous.fragmentIndex,
        );
      }
      session.lastReadAt = new Date().toISOString();
      await this.storage.saveSession(session);
      const { card } = await this.readWindow(edition, session);
      return { session, currentCard: card, fragmentRewound };
    }

    if ((session.currentWordOffset ?? 0) > 0 || session.currentCardIndex > 0) {
      session.currentWordOffset = 0;
      session.currentCardIndex = 0;
      const fragment = await this.getOrGenerateFragment(
        edition,
        session.currentFragmentIndex,
        session.activeContinuityNote,
      );
      session.titlePending = Boolean(extractLeadingChapterTitle(fragment.sourceSpan.blocks));
      session.lastReadAt = new Date().toISOString();
      await this.storage.saveSession(session);
      const { card } = await this.readWindow(edition, session);
      return { session, currentCard: card, fragmentRewound: false };
    }

    if (session.currentFragmentIndex > 0) {
      const prevIndex = session.currentFragmentIndex - 1;
      session.currentFragmentIndex = prevIndex;
      session.completedFragmentIndices = session.completedFragmentIndices.filter((idx) => idx !== prevIndex);
      session.currentWordOffset = 0;
      session.currentCardIndex = 0;
      const prevFragment = await this.getOrGenerateFragment(edition, prevIndex);
      session.titlePending = Boolean(extractLeadingChapterTitle(prevFragment.sourceSpan.blocks));
      session.lastReadAt = new Date().toISOString();
      await this.storage.saveSession(session);
      const { card } = await this.readWindow(edition, session);
      return { session, currentCard: card, fragmentRewound: true };
    }

    const { card } = await this.readWindow(edition, session);
    return { session, currentCard: card, fragmentRewound: false };
  }

  async resetSession(edition: Edition): Promise<ReaderSession> {
    const editionId = getEditionId(edition);
    const session: ReaderSession = {
      editionId,
      title: edition.metadata.title,
      currentFragmentIndex: 0,
      currentCardIndex: 0,
      currentWordOffset: 0,
      titlePending: false,
      windowHistory: [],
      totalFragments: edition.fragments.length,
      completedFragmentIndices: [],
      lastReadAt: new Date().toISOString(),
    };
    await this.storage.saveSession(session);
    return session;
  }

  async getOrGenerateFragment(
    edition: Edition,
    fragmentIndex: number,
    previousContinuityNote?: string,
  ): Promise<GeneratedFragment> {
    const editionId = getEditionId(edition);
    if (fragmentIndex < 0 || fragmentIndex >= edition.fragments.length) {
      throw new Error(`Fragment index ${fragmentIndex} is out of bounds for edition ${editionId} (${edition.fragments.length} total)`);
    }

    // 1. Instant Cache Hit
    const cached = await this.storage.getFragment(editionId, fragmentIndex);
    if (cached) {
      // Trigger background prefetch for upcoming window
      void this.prefetchRange(edition, fragmentIndex + 1, this.defaultBufferSize);
      return cached;
    }

    // 2. Dedup ongoing generation jobs
    const jobKey = `${editionId}:${fragmentIndex}`;
    const ongoing = this.activeJobs.get(jobKey);
    if (ongoing) {
      return ongoing;
    }

    // 3. Generate, validate, and store
    const job = (async () => {
      try {
        let noteToUse = previousContinuityNote;
        if (!noteToUse && fragmentIndex > 0) {
          const prior = await this.storage.getFragment(editionId, fragmentIndex - 1);
          noteToUse = prior?.rendition.continuityNote;
        }

        const generated = await generateFragment(edition, fragmentIndex, this.provider, {
          ...(this.judge ? { judge: this.judge } : {}),
          ...(noteToUse ? { previousContinuityNote: noteToUse } : {}),
        });

        await this.storage.saveFragment(editionId, fragmentIndex, generated);
        return generated;
      } finally {
        this.activeJobs.delete(jobKey);
      }
    })();

    this.activeJobs.set(jobKey, job);
    const result = await job;

    // Trigger background prefetch for upcoming window
    void this.prefetchRange(edition, fragmentIndex + 1, this.defaultBufferSize);

    return result;
  }

  async confirmAndAdvance(
    edition: Edition,
    bufferSize = this.defaultBufferSize,
  ): Promise<{ session: ReaderSession; nextFragment: GeneratedFragment | null }> {
    const editionId = getEditionId(edition);
    let session = await this.storage.getSession(editionId);
    if (!session) {
      session = await this.initializeSession(edition);
    }

    const currentIndex = session.currentFragmentIndex;
    const currentFragment = await this.storage.getFragment(editionId, currentIndex);

    if (!session.completedFragmentIndices.includes(currentIndex)) {
      session.completedFragmentIndices.push(currentIndex);
    }

    const nextIndex = currentIndex + 1;
    session.currentFragmentIndex = nextIndex;
    session.lastReadAt = new Date().toISOString();
    if (currentFragment?.rendition.continuityNote) {
      session.activeContinuityNote = currentFragment.rendition.continuityNote;
    }

    await this.storage.saveSession(session);

    let nextFragment: GeneratedFragment | null = null;
    if (nextIndex < edition.fragments.length) {
      nextFragment = await this.getOrGenerateFragment(edition, nextIndex, session.activeContinuityNote);
      // Trigger background prefetch for the buffer ahead
      void this.prefetchRange(edition, nextIndex + 1, bufferSize);
    }

    return { session, nextFragment };
  }

  async prefetchRange(edition: Edition, startIndex: number, count: number): Promise<void> {
    const editionId = getEditionId(edition);
    const endIndex = Math.min(startIndex + count, edition.fragments.length);
    let lastNote: string | undefined;

    for (let i = startIndex; i < endIndex; i++) {
      if (await this.storage.hasFragment(editionId, i)) {
        const cached = await this.storage.getFragment(editionId, i);
        lastNote = cached?.rendition.continuityNote;
        continue;
      }

      try {
        const generated = await this.getOrGenerateFragment(edition, i, lastNote);
        lastNote = generated.rendition.continuityNote;
      } catch {
        // Background prefetch error should never throw or break caller
        break;
      }
    }
  }

  private async readWindow(
    edition: Edition,
    session: ReaderSession,
  ): Promise<{
    card: WidgetCard;
    stream: ReturnType<typeof buildReadStream>;
    local: WindowPosition;
    sliceStart: number;
    bodies: FragmentBody[];
  }> {
    const sliceStart = Math.min(session.currentFragmentIndex, Math.max(0, edition.fragments.length - 1));
    const bodies = await this.loadWindowBodies(edition, session, sliceStart);
    const currentTitle = bodies[0]?.title;
    const atFragmentStart =
      session.currentCardIndex === 0 &&
      (session.currentWordOffset ?? 0) === 0 &&
      (session.windowHistory?.length ?? 0) === 0;
    if (atFragmentStart) {
      session.titlePending = Boolean(currentTitle);
    } else if (session.titlePending === undefined) {
      session.titlePending =
        Boolean(currentTitle) && (session.currentWordOffset ?? 0) === 0 && session.currentCardIndex === 0;
    }
    session.currentWordOffset = session.currentWordOffset ?? 0;
    session.windowHistory = session.windowHistory ?? [];

    const local: WindowPosition = {
      fragmentIndex: 0,
      wordOffset: session.currentWordOffset,
      titlePending: Boolean(session.titlePending),
      cardIndex: session.currentCardIndex,
    };
    const stream = buildReadStream(bodies, local);
    const extra = Math.max(1, Math.ceil(Math.max(stream.wordsUntilFragmentEnd, 1) / 45));
    const card: WidgetCard = {
      cardIndex: session.currentCardIndex,
      totalCards: Math.max(session.currentCardIndex + 1, session.currentCardIndex + extra),
      fragmentId: stream.fragmentId || edition.fragments[sliceStart]?.id || "fragment",
      text: stream.text,
      wordCount: stream.words.length,
      estimatedReadSeconds: Math.max(5, Math.round((Math.min(stream.words.length, 55) / 220) * 60)),
      isFinalCardOfFragment: stream.isTitleCard ? false : stream.wordsUntilFragmentEnd === 0,
      wordsUntilFragmentEnd: stream.wordsUntilFragmentEnd,
      isTitleCard: stream.isTitleCard,
    };
    return { card, stream, local, sliceStart, bodies };
  }

  private async loadWindowBodies(
    edition: Edition,
    session: ReaderSession,
    sliceStart: number,
  ): Promise<FragmentBody[]> {
    const bodies: FragmentBody[] = [];
    const last = Math.min(edition.fragments.length - 1, sliceStart + 3);
    for (let index = sliceStart; index <= last; index += 1) {
      const generated = await this.getOrGenerateFragment(
        edition,
        index,
        index === sliceStart ? session.activeContinuityNote : undefined,
      );
      const title = extractLeadingChapterTitle(generated.sourceSpan.blocks);
      bodies.push({
        fragmentId: generated.rendition.fragmentId,
        ...(title ? { title } : {}),
        bodyWords: fragmentBodyFromRendition(generated.rendition.fragment, title),
      });
      if (index > sliceStart && title) break;
    }
    return bodies;
  }

  private pushWindowHistory(session: ReaderSession): void {
    const history = session.windowHistory ?? [];
    const entry: WindowHistoryEntry = {
      fragmentIndex: session.currentFragmentIndex,
      wordOffset: session.currentWordOffset ?? 0,
      titlePending: Boolean(session.titlePending),
      cardIndex: session.currentCardIndex,
    };
    history.push(entry);
    session.windowHistory = history.slice(-80);
  }

  private applyWindowPosition(
    session: ReaderSession,
    sliceStart: number,
    local: WindowPosition,
    completedLocal: number[],
  ): void {
    session.currentFragmentIndex = sliceStart + local.fragmentIndex;
    session.currentWordOffset = local.wordOffset;
    session.titlePending = local.titlePending;
    session.currentCardIndex = local.cardIndex;
    for (const localIndex of completedLocal) {
      const absolute = sliceStart + localIndex;
      if (!session.completedFragmentIndices.includes(absolute)) {
        session.completedFragmentIndices.push(absolute);
      }
    }
  }
}
