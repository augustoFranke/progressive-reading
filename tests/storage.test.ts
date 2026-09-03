import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ingestUpload } from "../src/pipeline/ingestUpload.js";
import { generateFragment } from "../src/generate/generateFragment.js";
import { EditionStorage, getEditionId } from "../src/storage/cache.js";
import type { ReaderSession } from "../src/storage/types.js";

const root = resolve(import.meta.dirname, "..");

describe("EditionStorage cache layer", () => {
  let tempDir: string;
  let storage: EditionStorage;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "prog-reading-storage-test-"));
    storage = new EditionStorage(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it("persists and retrieves an ingested edition", async () => {
    const edition = await ingestUpload(resolve(root, "blood meridian.epub"));
    const editionId = getEditionId(edition);

    expect(await storage.hasEdition(editionId)).toBe(false);
    await storage.saveEdition(edition);
    expect(await storage.hasEdition(editionId)).toBe(true);

    const retrieved = await storage.getEdition(editionId);
    expect(retrieved?.metadata.title).toBe(edition.metadata.title);
    expect(retrieved?.fragments.length).toBe(edition.fragments.length);
    expect(retrieved?.blocks.length).toBe(edition.blocks.length);
  });

  it("persists and retrieves generated fragments and reader sessions", async () => {
    const edition = await ingestUpload(resolve(root, "blood meridian.epub"));
    const editionId = getEditionId(edition);
    const generated = await generateFragment(edition, 0);

    expect(await storage.hasFragment(editionId, 0)).toBe(false);
    await storage.saveFragment(editionId, 0, generated);
    expect(await storage.hasFragment(editionId, 0)).toBe(true);

    const retrievedFragment = await storage.getFragment(editionId, 0);
    expect(retrievedFragment?.rendition.fragmentId).toBe(edition.fragments[0].id);
    expect(retrievedFragment?.rendition.fragment).toBe(generated.rendition.fragment);
    expect(retrievedFragment?.validation.status).toBe(generated.validation.status);

    const session: ReaderSession = {
      editionId,
      title: edition.metadata.title,
      currentFragmentIndex: 0,
      currentCardIndex: 0,
      totalFragments: edition.fragments.length,
      completedFragmentIndices: [0],
      lastReadAt: new Date().toISOString(),
      activeContinuityNote: generated.rendition.continuityNote,
    };

    await storage.saveSession(session);
    const retrievedSession = await storage.getSession(editionId);
    expect(retrievedSession?.currentFragmentIndex).toBe(0);
    expect(retrievedSession?.completedFragmentIndices).toContain(0);
    expect(retrievedSession?.activeContinuityNote).toBe(generated.rendition.continuityNote);
  });
});
