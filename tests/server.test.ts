import { readFile, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createReadingServer } from "../src/server.js";
import { EditionStorage } from "../src/storage/cache.js";

const root = resolve(import.meta.dirname, "..");

describe("Progressive Reading REST API Server", () => {
  let tempDir: string;
  let serverInstance: ReturnType<typeof createReadingServer>;
  let baseUrl: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "prog-reading-server-test-"));
    const storage = new EditionStorage(tempDir);
    serverInstance = createReadingServer({ storage, port: 0, host: "127.0.0.1", autoDiscover: false });
    const port = await serverInstance.listen(0, "127.0.0.1");
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await serverInstance.close();
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it("returns health status on GET /api/health", async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.provider).toBeDefined();
  });

  it("handles EPUB upload, card retrieval, and advance progression", async () => {
    const epubBuffer = await readFile(resolve(root, "blood meridian.epub"));

    // 1. Upload EPUB
    const uploadRes = await fetch(`${baseUrl}/api/books/upload`, {
      method: "POST",
      headers: { "Content-Type": "application/epub+zip" },
      body: epubBuffer,
    });
    expect(uploadRes.status).toBe(201);
    const uploadBody = await uploadRes.json();
    expect(uploadBody.editionId).toBeDefined();
    expect(uploadBody.title).toBe("Blood Meridian");
    expect(uploadBody.totalFragments).toBe(94);

    const bookId = uploadBody.editionId;

    // 2. List books
    const booksRes = await fetch(`${baseUrl}/api/books`);
    expect(booksRes.status).toBe(200);
    const booksBody = await booksRes.json();
    expect(booksBody.books.length).toBeGreaterThanOrEqual(1);

    // 3. Get current card
    const cardRes = await fetch(`${baseUrl}/api/books/${bookId}/card`);
    expect(cardRes.status).toBe(200);
    const cardBody = await cardRes.json();
    expect(cardBody.card.cardIndex).toBe(0);
    expect(cardBody.card.text.length).toBeGreaterThan(0);

    // 4. Compact Widget endpoint
    const widgetRes = await fetch(`${baseUrl}/api/widget/current`);
    expect(widgetRes.status).toBe(200);
    const widgetBody = await widgetRes.json();
    expect(widgetBody.hasBook).toBe(true);
    expect(widgetBody.cardIndex).toBe(1);
    expect(widgetBody.text).toBe(cardBody.card.text);

    // 5. Advance card
    const advanceRes = await fetch(`${baseUrl}/api/books/${bookId}/advance`, {
      method: "POST",
    });
    expect(advanceRes.status).toBe(200);
    const advanceBody = await advanceRes.json();
    expect(advanceBody.currentCard.cardIndex).toBe(1);

    // 6. Rewind card (Undo miss-click)
    const rewindRes = await fetch(`${baseUrl}/api/books/${bookId}/rewind`, {
      method: "POST",
    });
    expect(rewindRes.status).toBe(200);
    const rewindBody = await rewindRes.json();
    expect(rewindBody.currentCard.cardIndex).toBe(0);

    // 7. Reset book progress
    const resetRes = await fetch(`${baseUrl}/api/books/${bookId}/reset`, {
      method: "POST",
    });
    expect(resetRes.status).toBe(200);
    const resetBody = await resetRes.json();
    expect(resetBody.session.currentCardIndex).toBe(0);
    expect(resetBody.session.currentFragmentIndex).toBe(0);
  }, 15000);

  it("rejects an empty upload body with a readable message", async () => {
    const res = await fetch(`${baseUrl}/api/books/upload`, {
      method: "POST",
      headers: { "Content-Type": "application/epub+zip" },
      body: new Uint8Array(0),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/vazio/iu);
  });

  it("rejects a non-EPUB payload with a readable message instead of a 500", async () => {
    const res = await fetch(`${baseUrl}/api/books/upload`, {
      method: "POST",
      headers: { "Content-Type": "application/epub+zip" },
      body: "this is definitely not an epub",
    });
    expect(res.status).toBe(415);
    expect((await res.json()).error).toMatch(/EPUB/u);
  });

  it("names an untitled upload after the client-provided file name", async () => {
    const epubBuffer = await readFile(resolve(root, "moby dick.epub"));
    const res = await fetch(`${baseUrl}/api/books/upload`, {
      method: "POST",
      headers: {
        "Content-Type": "application/epub+zip",
        "X-File-Name": encodeURIComponent("moby dick.epub"),
      },
      body: epubBuffer,
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    // Metadata title still wins; the header only feeds the fallback identifier.
    expect(body.editionId).toBe("Moby_Dick");
    expect(body.percentCompleted).toBe(0);
  }, 15000);

  it("widget defaults to last-read book and supports bookId targeting with rewind", async () => {
    const bloodMeridian = await readFile(resolve(root, "blood meridian.epub"));
    const mobyDick = await readFile(resolve(root, "moby dick.epub"));

    const uploadA = await fetch(`${baseUrl}/api/books/upload`, {
      method: "POST",
      headers: { "Content-Type": "application/epub+zip" },
      body: bloodMeridian,
    });
    expect(uploadA.status).toBe(201);
    const bookA = (await uploadA.json()).editionId as string;

    // Advance book A a couple of cards
    await fetch(`${baseUrl}/api/books/${bookA}/advance`, { method: "POST" });
    await fetch(`${baseUrl}/api/books/${bookA}/advance`, { method: "POST" });

    const uploadB = await fetch(`${baseUrl}/api/books/upload`, {
      method: "POST",
      headers: {
        "Content-Type": "application/epub+zip",
        "X-File-Name": encodeURIComponent("moby dick.epub"),
      },
      body: mobyDick,
    });
    expect(uploadB.status).toBe(201);
    const bookB = (await uploadB.json()).editionId as string;
    expect(bookB).toBe("Moby_Dick");

    // Opening book B in the app marks it as last-read
    const cardBRes = await fetch(`${baseUrl}/api/books/${bookB}/card`);
    expect(cardBRes.status).toBe(200);
    const cardBBody = await cardBRes.json();

    // Default widget current should show book B (last-read), not filesystem order
    const defaultWidget = await fetch(`${baseUrl}/api/widget/current`);
    expect(defaultWidget.status).toBe(200);
    const defaultBody = await defaultWidget.json();
    expect(defaultBody.hasBook).toBe(true);
    expect(defaultBody.editionId).toBe(bookB);
    expect(defaultBody.title).toBe(cardBBody.title);

    // Explicit bookId targets book A regardless of last-read
    const widgetA = await fetch(`${baseUrl}/api/widget/current?bookId=${encodeURIComponent(bookA)}`);
    expect(widgetA.status).toBe(200);
    const widgetABody = await widgetA.json();
    expect(widgetABody.editionId).toBe(bookA);
    expect(widgetABody.cardIndex).toBe(3); // advanced twice from card 1

    // Widget advance and rewind on book A
    const advanceWidget = await fetch(`${baseUrl}/api/widget/advance`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bookId: bookA }),
    });
    expect(advanceWidget.status).toBe(200);
    const advanceWidgetBody = await advanceWidget.json();
    expect(advanceWidgetBody.currentCard.cardIndex).toBe(3);

    const rewindWidget = await fetch(`${baseUrl}/api/widget/rewind`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bookId: bookA }),
    });
    expect(rewindWidget.status).toBe(200);
    const rewindWidgetBody = await rewindWidget.json();
    expect(rewindWidgetBody.currentCard.cardIndex).toBe(2);

    const widgetAAfterRewind = await fetch(
      `${baseUrl}/api/widget/current?bookId=${encodeURIComponent(bookA)}`,
    );
    const widgetAAfterBody = await widgetAAfterRewind.json();
    expect(widgetAAfterBody.cardIndex).toBe(3); // 0-based index 2 → display cardIndex 3
  }, 30000);
});
