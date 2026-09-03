import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ingestUpload } from "../src/pipeline/ingestUpload.js";
import { BufferEngine } from "../src/pipeline/bufferEngine.js";
import { EditionStorage, getEditionId } from "../src/storage/cache.js";
import { LocalQualityJudge } from "../src/generate/qualityJudge.js";

const root = resolve(import.meta.dirname, "..");

describe("BufferEngine background prefetch and reader loop", () => {
  let tempDir: string;
  let storage: EditionStorage;
  let engine: BufferEngine;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "prog-reading-buffer-test-"));
    storage = new EditionStorage(tempDir);
    engine = new BufferEngine({
      storage,
      judge: new LocalQualityJudge(),
      defaultBufferSize: 3,
    });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it("initializes reader session and fetches current fragment with cache hits", async () => {
    const edition = await ingestUpload(resolve(root, "blood meridian.epub"));
    const editionId = getEditionId(edition);

    const session = await engine.initializeSession(edition);
    expect(session.currentFragmentIndex).toBe(0);
    expect(session.editionId).toBe(editionId);

    const first = await engine.getCurrentFragment(edition);
    expect(first.rendition.fragmentId).toBe(edition.fragments[0].id);

    // Verify it is stored in cache
    expect(await storage.hasFragment(editionId, 0)).toBe(true);

    // Immediate secondary call should return instant cache hit
    const cached = await engine.getCurrentFragment(edition);
    expect(cached.rendition.fragment).toBe(first.rendition.fragment);
  });

  it("confirms reading and advances sequentially without blocking reader", async () => {
    const edition = await ingestUpload(resolve(root, "blood meridian.epub"));

    await engine.initializeSession(edition);

    // Advance from 0 to 1
    const { session: session1, nextFragment: frag1 } = await engine.confirmAndAdvance(edition);
    expect(session1.currentFragmentIndex).toBe(1);
    expect(session1.completedFragmentIndices).toContain(0);
    expect(frag1?.rendition.fragmentId).toBe(edition.fragments[1].id);

    // Advance from 1 to 2
    const { session: session2, nextFragment: frag2 } = await engine.confirmAndAdvance(edition);
    expect(session2.currentFragmentIndex).toBe(2);
    expect(session2.completedFragmentIndices).toEqual([0, 1]);
    expect(frag2?.rendition.fragmentId).toBe(edition.fragments[2].id);
  });

  it("reads card-by-card in widget and advances to next fragment on final card", async () => {
    const edition = await ingestUpload(resolve(root, "blood meridian.epub"));

    await engine.initializeSession(edition);
    const card0 = await engine.getCurrentCard(edition);

    expect(card0.cardIndex).toBe(0);
    expect(card0.totalCards).toBeGreaterThanOrEqual(1);

    // Step through cards until we advance to next fragment
    let advanced = false;
    let iterations = 0;
    const maxIterations = 80;
    while (!advanced && iterations < maxIterations) {
      iterations++;
      const result = await engine.confirmAndAdvanceCard(edition);
      if (result.fragmentAdvanced) {
        advanced = true;
        expect(result.session.currentFragmentIndex).toBe(1);
        if (result.currentCard?.isTitleCard) {
          expect(result.session.currentCardIndex).toBe(0);
          expect(result.currentCard?.cardIndex).toBe(0);
        }
      } else {
        expect(result.session.currentFragmentIndex).toBe(0);
        expect(result.currentCard?.cardIndex).toBeGreaterThan(0);
      }
    }

    expect(advanced).toBe(true);
  });

  it("opens a chapter on a title-only card before the prose", async () => {
    const edition = await ingestUpload(resolve(root, "blood meridian.epub"));
    await engine.initializeSession(edition);
    const card0 = await engine.getCurrentCard(edition);

    expect(card0.cardIndex).toBe(0);
    expect(card0.text).toMatch(/^I Childhood in Tennessee/u);
    expect(card0.text).not.toMatch(/See the child/u);
    expect(card0.isFinalCardOfFragment).toBe(false);

    const next = await engine.confirmAndAdvanceCard(edition);
    expect(next.fragmentAdvanced).toBe(false);
    expect(next.currentCard?.cardIndex).toBe(1);
    expect(next.currentCard?.text).not.toMatch(/^I Childhood/u);

    const bodyStart = next.currentCard?.text ?? "";
    const stepped = await engine.confirmAndAdvanceCard(edition, { consumedWordCount: 8 });
    expect(stepped.fragmentAdvanced).toBe(false);
    const after = stepped.currentCard?.text ?? "";
    expect(after).not.toBe(bodyStart);
    const startWords = bodyStart.split(/\s+/u).filter((word) => word.length > 0).slice(0, 8);
    expect(bodyStart.startsWith(startWords.join(" "))).toBe(true);
    expect(after.startsWith(startWords.join(" "))).toBe(false);
  });

  it("rewinds from card 1 back to card 0 within the same fragment", async () => {
    const edition = await ingestUpload(resolve(root, "blood meridian.epub"));

    await engine.initializeSession(edition);
    const card0 = await engine.getCurrentCard(edition);
    expect(card0.cardIndex).toBe(0);

    const advanced = await engine.confirmAndAdvanceCard(edition);
    expect(advanced.currentCard?.cardIndex).toBe(1);

    const rewound = await engine.rewindCard(edition);
    expect(rewound.currentCard?.cardIndex).toBe(0);
    expect(rewound.fragmentRewound).toBe(false);
  });
});
