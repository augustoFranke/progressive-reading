import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { ingestUpload } from "./pipeline/ingestUpload.js";
import { extractCoverImage } from "./ingest/cover.js";
import { BufferEngine } from "./pipeline/bufferEngine.js";
import { EditionStorage, getEditionId } from "./storage/cache.js";
import { GeminiProvider } from "./generate/geminiProvider.js";
import { LocalDraftProvider } from "./generate/localProvider.js";
import { GeminiQualityJudge, LocalQualityJudge } from "./generate/qualityJudge.js";
import type { Edition } from "./core/types.js";

/** Hard ceiling for an uploaded EPUB body, so a stuck client cannot exhaust server memory. */
const MAX_UPLOAD_BYTES = 80 * 1024 * 1024;

export interface ServerOptions {
  port?: number;
  host?: string;
  storage?: EditionStorage;
  useGemini?: boolean;
  autoDiscover?: boolean;
}

export function createReadingServer(options: ServerOptions = {}) {
  const storage = options.storage ?? new EditionStorage();
  const useGemini = options.useGemini ?? Boolean(process.env.GEMINI_API_KEY?.trim());
  const provider = useGemini ? new GeminiProvider() : new LocalDraftProvider();
  const judge = useGemini ? new GeminiQualityJudge() : new LocalQualityJudge();

  const engine = new BufferEngine({
    storage,
    provider,
    judge,
    defaultBufferSize: 3,
  });

  const autoDiscoverEnabled = options.autoDiscover ?? true;
  let workspaceDiscovery: Promise<void> | null = null;
  const ensureWorkspaceDiscovered = (): Promise<void> => {
    workspaceDiscovery ??= autoDiscoverWorkspaceEpubs(storage).catch(() => {});
    return workspaceDiscovery;
  };

  if (autoDiscoverEnabled) {
    void ensureWorkspaceDiscovered();
  }

  const server = createServer(async (req, res) => {
    // Set CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", `http://${req.headers.host || "localhost"}`);
    const pathname = url.pathname;

    try {
      // 0. OTA Installation landing page and manifest for Remote iPhone Installation
      if ((pathname === "/" || pathname === "/install") && req.method === "GET") {
        const hostOrigin = `https://${url.host}`;
        const installUrl = `itms-services://?action=download-manifest&url=${encodeURIComponent(`${hostOrigin}/ota/manifest.plist`)}`;
        const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Instalar Progressive Reading</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: #f2f2f7;
      color: #1c1c1e;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
      padding: 24px;
      box-sizing: border-box;
      text-align: center;
    }
    .card {
      background: #ffffff;
      border-radius: 24px;
      padding: 36px 28px;
      box-shadow: 0 8px 30px rgba(0,0,0,0.08);
      max-width: 360px;
      width: 100%;
    }
    .icon {
      font-size: 54px;
      margin-bottom: 12px;
    }
    h1 {
      font-size: 22px;
      margin: 0 0 8px;
      font-weight: 700;
    }
    p {
      color: #8e8e93;
      font-size: 14px;
      line-height: 1.5;
      margin: 0 0 28px;
    }
    .btn {
      display: block;
      background: #007aff;
      color: #ffffff;
      text-decoration: none;
      font-weight: 600;
      font-size: 16px;
      padding: 16px;
      border-radius: 14px;
      box-shadow: 0 4px 14px rgba(0,122,255,0.3);
      transition: transform 0.1s ease;
    }
    .btn:active {
      transform: scale(0.97);
    }
    .note {
      margin-top: 20px;
      font-size: 12px;
      color: #aeaeb2;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">📖</div>
    <h1>Progressive Reading</h1>
    <p>Instale a versão atualizada diretamente no seu iPhone pela internet.</p>
    <a href="${installUrl}" class="btn">Instalar no iPhone</a>
    <div class="note">Ao tocar em instalar, confirme o diálogo e volte para a Tela de Início para ver o app sendo instalado.</div>
  </div>
</body>
</html>`;
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }

      if (pathname === "/ota/manifest.plist" && req.method === "GET") {
        const hostOrigin = `https://${url.host}`;
        const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>items</key>
	<array>
		<dict>
			<key>assets</key>
			<array>
				<dict>
					<key>kind</key>
					<string>software-package</string>
					<key>url</key>
					<string>${hostOrigin}/ota/ProgressiveReading.ipa</string>
				</dict>
			</array>
			<key>metadata</key>
			<dict>
				<key>bundle-identifier</key>
				<string>com.augustofranke.progressivereading</string>
				<key>bundle-version</key>
				<string>1.0</string>
				<key>kind</key>
				<string>software</string>
				<key>title</key>
				<string>Progressive Reading</string>
			</dict>
		</dict>
	</array>
</dict>
</plist>`;
        res.writeHead(200, { "Content-Type": "text/xml; charset=utf-8" });
        res.end(plist);
        return;
      }

      if (pathname === "/ota/ProgressiveReading.ipa" && req.method === "GET") {
        try {
          const ipaData = await readFile("/tmp/ota/ProgressiveReading.ipa");
          res.writeHead(200, {
            "Content-Type": "application/octet-stream",
            "Content-Length": ipaData.length,
          });
          res.end(ipaData);
          return;
        } catch {
          return sendJson(res, 404, { error: "IPA not found on server" });
        }
      }

      // 1. Health check
      if (pathname === "/api/health" && req.method === "GET") {
        return sendJson(res, 200, { status: "ok", provider: provider.id, judge: judge.id });
      }

      // 2. List all books
      if (pathname === "/api/books" && req.method === "GET") {
        const editionsDir = join(storage.baseDir, "editions");
        const books: Array<{
          id: string;
          title: string;
          author?: string;
          totalFragments: number;
          completedFragments: number;
          percentCompleted: number;
          lastReadAt?: string;
          hasCover: boolean;
        }> = [];

        try {
          const files = await readdir(editionsDir);
          for (const f of files) {
            if (f.endsWith(".json")) {
              const id = f.replace(/\.json$/u, "");
              const edition = await storage.getEdition(id);
              const session = await storage.getSession(id);
              if (edition) {
                const total = edition.fragments.length;
                const completed = session?.completedFragmentIndices.length ?? 0;
                books.push({
                  id,
                  title: edition.metadata.title || id,
                  author: edition.metadata.author,
                  totalFragments: total,
                  completedFragments: completed,
                  percentCompleted: total > 0 ? Math.round((completed / total) * 100) : 0,
                  lastReadAt: session?.lastReadAt,
                  hasCover: await storage.hasCover(id),
                });
              }
            }
          }
        } catch {
          // dir not created yet
        }

        return sendJson(res, 200, { books });
      }

      // 3. Upload and ingest an EPUB
      if (pathname === "/api/books/upload" && req.method === "POST") {
        let bodyBuffer: Buffer;
        try {
          bodyBuffer = await readRequestBodyBuffer(req, MAX_UPLOAD_BYTES);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          sendJson(res, 413, { error: message });
          req.destroy();
          return;
        }

        if (bodyBuffer.length === 0) {
          return sendJson(res, 400, { error: "Arquivo vazio: envie o conteúdo binário do EPUB." });
        }
        if (!isZipArchive(bodyBuffer)) {
          return sendJson(res, 415, {
            error: "O arquivo enviado não é um EPUB válido (esperado um pacote .epub).",
          });
        }

        const originalName = readFileNameHeader(req);
        const tempFile = join(tmpdir(), `upload-${randomUUID()}.epub`);
        await writeFile(tempFile, bodyBuffer);

        try {
          let edition: Edition;
          try {
            edition = await ingestUpload(tempFile);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return sendJson(res, 422, { error: `Não foi possível processar o EPUB: ${message}` });
          }

          if (edition.fragments.length === 0) {
            return sendJson(res, 422, {
              error: "O EPUB foi lido, mas nenhum trecho legível foi encontrado.",
            });
          }

          if (originalName) edition.sourcePath = originalName;
          const editionId = getEditionId(edition);
          await storage.saveEdition(edition, editionId);
          // The upload is deleted in `finally`, so the cover must be taken now or never.
          const cover = extractCoverImage(bodyBuffer);
          if (cover) {
            await storage.saveCover(editionId, cover.data, cover.mediaType).catch(() => {});
          }
          // Session setup only; fragment generation continues in the background so the
          // client gets its book back immediately instead of waiting on the model.
          const session = await engine.initializeSession(edition);

          return sendJson(res, 201, {
            id: editionId,
            editionId,
            title: edition.metadata.title || editionId,
            author: edition.metadata.author,
            totalFragments: edition.fragments.length,
            completedFragments: session.completedFragmentIndices.length,
            percentCompleted:
              edition.fragments.length > 0
                ? Math.round((session.completedFragmentIndices.length / edition.fragments.length) * 100)
                : 0,
            lastReadAt: session.lastReadAt,
            hasCover: cover !== null,
          });
        } finally {
          await rm(tempFile, { force: true }).catch(() => {});
        }
      }

      // 3b. Cover art for a book
      const coverMatch = pathname.match(/^\/api\/books\/([^/]+)\/cover$/u);
      if (coverMatch && req.method === "GET") {
        const editionId = coverMatch[1];
        let cover = await storage.getCover(editionId);

        // Books ingested before covers existed (and workspace files) still have a real
        // source on disk; extract once and cache so this stays a one-time cost.
        if (!cover) {
          const edition = await storage.getEdition(editionId);
          const sourcePath = edition?.sourcePath;
          if (sourcePath) {
            try {
              const extracted = extractCoverImage(await readFile(sourcePath));
              if (extracted) {
                await storage.saveCover(editionId, extracted.data, extracted.mediaType);
                cover = { data: Buffer.from(extracted.data), mediaType: extracted.mediaType };
              }
            } catch {
              // No readable source: fall through to 404 and let the client draw a placeholder.
            }
          }
        }

        if (!cover) {
          return sendJson(res, 404, { error: `No cover for '${editionId}'` });
        }

        res.writeHead(200, {
          "Content-Type": cover.mediaType,
          "Content-Length": cover.data.length,
          "Cache-Control": "public, max-age=86400",
        });
        return res.end(cover.data);
      }

      // 4. Get active card for a specific book
      const cardMatch = pathname.match(/^\/api\/books\/([^/]+)\/card$/u);
      if (cardMatch && req.method === "GET") {
        const editionId = cardMatch[1];
        const edition = await storage.getEdition(editionId);
        if (!edition) {
          return sendJson(res, 404, { error: `Book '${editionId}' not found` });
        }

        const session = await engine.initializeSession(edition);
        // Opening a book in the app marks it as the most recently read edition.
        session.lastReadAt = new Date().toISOString();
        await storage.saveSession(session);
        const card = await engine.getCurrentCard(edition);

        return sendJson(res, 200, {
          editionId,
          title: edition.metadata.title,
          author: edition.metadata.author,
          session,
          card,
        });
      }

      // 5. Advance card for a specific book
      const advanceMatch = pathname.match(/^\/api\/books\/([^/]+)\/advance$/u);
      if (advanceMatch && req.method === "POST") {
        const editionId = advanceMatch[1];
        const edition = await storage.getEdition(editionId);
        if (!edition) {
          return sendJson(res, 404, { error: `Book '${editionId}' not found` });
        }

        let advanceBody: Record<string, unknown> = {};
        try {
          const raw = await readRequestBodyText(req);
          if (raw) advanceBody = JSON.parse(raw);
        } catch {}

        const result = await engine.confirmAndAdvanceCard(edition, {
          consumedWordCount: readConsumedWordCount(advanceBody),
        });
        return sendJson(res, 200, {
          editionId,
          title: edition.metadata.title,
          session: result.session,
          currentCard: result.currentCard,
          fragmentAdvanced: result.fragmentAdvanced,
        });
      }

      // 6. Rewind card for a specific book (Undo miss-click)
      const rewindMatch = pathname.match(/^\/api\/books\/([^/]+)\/rewind$/u);
      if (rewindMatch && req.method === "POST") {
        const editionId = rewindMatch[1];
        const edition = await storage.getEdition(editionId);
        if (!edition) {
          return sendJson(res, 404, { error: `Book '${editionId}' not found` });
        }

        const result = await engine.rewindCard(edition);
        return sendJson(res, 200, {
          editionId,
          title: edition.metadata.title,
          session: result.session,
          currentCard: result.currentCard,
          fragmentRewound: result.fragmentRewound,
        });
      }

      // 7. Reset book progress to beginning
      const resetMatch = pathname.match(/^\/api\/books\/([^/]+)\/reset$/u);
      if (resetMatch && req.method === "POST") {
        const editionId = resetMatch[1];
        const edition = await storage.getEdition(editionId);
        if (!edition) {
          return sendJson(res, 404, { error: `Book '${editionId}' not found` });
        }

        const session = await engine.resetSession(edition);
        const card = await engine.getCurrentCard(edition);
        return sendJson(res, 200, {
          editionId,
          title: edition.metadata.title,
          session,
          currentCard: card,
        });
      }

      // 8. Compact Widget Endpoint (iOS WidgetKit Timeline Provider)
      if (pathname === "/api/widget/current" && req.method === "GET") {
        const requestedId = url.searchParams.get("bookId");
        const edition = await resolveWidgetEdition(
          storage,
          requestedId,
          autoDiscoverEnabled,
          ensureWorkspaceDiscovered,
        );

        if (!edition) {
          return sendJson(res, 200, {
            hasBook: false,
            message: "No books uploaded yet. Add an EPUB in the app.",
          });
        }

        const editionId = getEditionId(edition);
        const session = await engine.initializeSession(edition);
        const card = await engine.getCurrentCard(edition);
        const progressPercent =
          edition.fragments.length > 0
            ? Math.round((session.completedFragmentIndices.length / edition.fragments.length) * 100)
            : 0;

        return sendJson(res, 200, {
          hasBook: true,
          editionId,
          title: edition.metadata.title,
          author: edition.metadata.author,
          fragmentIndex: session.currentFragmentIndex + 1,
          totalFragments: session.totalFragments,
          cardIndex: card.cardIndex + 1,
          totalCards: card.totalCards,
          progressPercent,
          text: card.text,
          estimatedReadSeconds: card.estimatedReadSeconds,
          isFinalCardOfFragment: card.isFinalCardOfFragment,
          wordsUntilFragmentEnd: card.wordsUntilFragmentEnd ?? card.wordCount,
          isTitleCard: Boolean(card.isTitleCard),
        });
      }

      // 9. Interactive Widget Advance Intent (iOS 17+ AppIntent)
      if (pathname === "/api/widget/advance" && req.method === "POST") {
        let bodyJson: Record<string, unknown> = {};
        try {
          const raw = await readRequestBodyText(req);
          if (raw) bodyJson = JSON.parse(raw);
        } catch {}

        const requestedId = (bodyJson.bookId as string) || url.searchParams.get("bookId");
        const edition = await resolveWidgetEdition(
          storage,
          requestedId,
          autoDiscoverEnabled,
          ensureWorkspaceDiscovered,
        );

        if (!edition) {
          return sendJson(res, 404, { error: "No active book found to advance" });
        }

        const result = await engine.confirmAndAdvanceCard(edition, {
          consumedWordCount: readConsumedWordCount(bodyJson),
        });
        const progressPercent =
          edition.fragments.length > 0
            ? Math.round((result.session.completedFragmentIndices.length / edition.fragments.length) * 100)
            : 0;

        return sendJson(res, 200, {
          editionId: result.session.editionId,
          title: edition.metadata.title,
          currentCard: result.currentCard,
          session: result.session,
          progressPercent,
          fragmentAdvanced: result.fragmentAdvanced,
        });
      }

      // 10. Interactive Widget Rewind Intent (iOS 17+ AppIntent)
      if (pathname === "/api/widget/rewind" && req.method === "POST") {
        let bodyJson: Record<string, unknown> = {};
        try {
          const raw = await readRequestBodyText(req);
          if (raw) bodyJson = JSON.parse(raw);
        } catch {}

        const requestedId = (bodyJson.bookId as string) || url.searchParams.get("bookId");
        const edition = await resolveWidgetEdition(
          storage,
          requestedId,
          autoDiscoverEnabled,
          ensureWorkspaceDiscovered,
        );

        if (!edition) {
          return sendJson(res, 404, { error: "No active book found to rewind" });
        }

        const result = await engine.rewindCard(edition);
        const progressPercent =
          edition.fragments.length > 0
            ? Math.round((result.session.completedFragmentIndices.length / edition.fragments.length) * 100)
            : 0;

        return sendJson(res, 200, {
          editionId: result.session.editionId,
          title: edition.metadata.title,
          currentCard: result.currentCard,
          session: result.session,
          progressPercent,
          fragmentRewound: result.fragmentRewound,
        });
      }

      // Not found
      return sendJson(res, 404, { error: `Endpoint '${pathname}' not found` });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (!process.env.VITEST) {
        console.error(`[500] ${req.method} ${pathname}: ${message}`);
      }
      return sendJson(res, 500, { error: message });
    }
  });

  return {
    server,
    listen(port = options.port ?? 3000, host = options.host ?? "0.0.0.0") {
      return new Promise<number>((resolvePromise) => {
        server.listen(port, host, () => {
          const addr = server.address();
          const actualPort = typeof addr === "object" && addr ? addr.port : port;
          resolvePromise(actualPort);
        });
      });
    },
    close() {
      return new Promise<void>((resolvePromise, reject) => {
        server.close((err) => (err ? reject(err) : resolvePromise()));
      });
    },
  };
}

interface DiscoveredSource {
  size: number;
  mtimeMs: number;
  editionId: string;
}

/**
 * Imports EPUBs sitting in the workspace once per server run. Ingest is CPU-bound and
 * blocks the event loop, so already-known files are skipped and the loop yields between
 * books to keep the API responsive while discovery runs.
 */
async function autoDiscoverWorkspaceEpubs(storage: EditionStorage): Promise<void> {
  const indexPath = join(storage.baseDir, "discovered-sources.json");
  let index: Record<string, DiscoveredSource> = {};
  try {
    index = JSON.parse(await readFile(indexPath, "utf-8")) as Record<string, DiscoveredSource>;
  } catch {}

  let cwdFiles: string[];
  try {
    cwdFiles = await readdir(process.cwd());
  } catch {
    return;
  }

  let indexChanged = false;
  for (const file of cwdFiles) {
    if (!file.endsWith(".epub") || file.startsWith(".")) continue;
    const fullPath = join(process.cwd(), file);

    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(fullPath);
    } catch {
      continue;
    }

    const known = index[fullPath];
    if (
      known &&
      known.size === info.size &&
      known.mtimeMs === info.mtimeMs &&
      (await storage.hasEdition(known.editionId))
    ) {
      // Edition is current, but it may predate cover support: backfill art only.
      if (!(await storage.hasCover(known.editionId))) {
        try {
          const cover = extractCoverImage(await readFile(fullPath));
          if (cover) await storage.saveCover(known.editionId, cover.data, cover.mediaType);
        } catch {}
      }
      continue;
    }

    try {
      const edition = await ingestUpload(fullPath);
      const editionId = getEditionId(edition);
      if (!(await storage.hasEdition(editionId))) {
        await storage.saveEdition(edition, editionId);
      }
      if (!(await storage.hasCover(editionId))) {
        const cover = extractCoverImage(await readFile(fullPath));
        if (cover) await storage.saveCover(editionId, cover.data, cover.mediaType).catch(() => {});
      }
      index[fullPath] = { size: info.size, mtimeMs: info.mtimeMs, editionId };
      indexChanged = true;
    } catch {}

    await new Promise((r) => setImmediate(r));
  }

  if (indexChanged) {
    try {
      await mkdir(dirname(indexPath), { recursive: true });
      await writeFile(indexPath, JSON.stringify(index, null, 2), "utf-8");
    } catch {}
  }
}

/**
 * Resolves which edition a widget endpoint should target.
 * Explicit bookId wins; otherwise pick the edition with the latest session.lastReadAt.
 */
async function resolveWidgetEdition(
  storage: EditionStorage,
  requestedId: string | null | undefined,
  autoDiscover: boolean,
  ensureDiscovered: () => Promise<void>,
): Promise<Edition | null> {
  if (requestedId) {
    return await storage.getEdition(requestedId);
  }

  if (autoDiscover) await ensureDiscovered();
  const editions = await getAvailableEditions(storage);
  if (editions.length === 0) return null;

  let bestEdition = editions[0];
  let bestLastReadAt = "";

  for (const edition of editions) {
    const editionId = getEditionId(edition);
    const session = await storage.getSession(editionId);
    const lastReadAt = session?.lastReadAt ?? "";
    if (lastReadAt > bestLastReadAt) {
      bestLastReadAt = lastReadAt;
      bestEdition = edition;
    }
  }

  return bestEdition;
}

async function getAvailableEditions(storage: EditionStorage): Promise<Edition[]> {
  const editionsDir = join(storage.baseDir, "editions");
  const result: Edition[] = [];
  try {
    const files = await readdir(editionsDir);
    for (const f of files) {
      if (f.endsWith(".json")) {
        const id = f.replace(/\.json$/u, "");
        const ed = await storage.getEdition(id);
        if (ed) result.push(ed);
      }
    }
  } catch {}
  return result;
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown) {
  const data = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(data),
  });
  res.end(data);
}

function readRequestBodyBuffer(req: IncomingMessage, maxBytes = Number.POSITIVE_INFINITY): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    req.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (received > maxBytes) {
        // Stop buffering but keep the socket alive so the 413 response reaches the client.
        req.pause();
        reject(new Error(`Arquivo acima do limite de ${Math.round(maxBytes / (1024 * 1024))} MB.`));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolvePromise(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** EPUBs are ZIP containers; anything else fails ingest with an opaque error. */
function isZipArchive(buffer: Buffer): boolean {
  return buffer.length > 4 && buffer[0] === 0x50 && buffer[1] === 0x4b;
}

function readFileNameHeader(req: IncomingMessage): string | undefined {
  const raw = req.headers["x-file-name"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return undefined;
  try {
    const decoded = decodeURIComponent(value).trim();
    return decoded ? decoded.split(/[/\\]/u).pop() : undefined;
  } catch {
    return undefined;
  }
}

function readConsumedWordCount(body: Record<string, unknown>): number | undefined {
  const raw = body.consumedWordCount;
  const value = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isFinite(value) || value < 0) return undefined;
  return Math.floor(value);
}

function readRequestBodyText(req: IncomingMessage): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolvePromise(data));
    req.on("error", reject);
  });
}

// Standalone entrypoint when executed directly via node or tsx
if (!process.env.VITEST) {
  // Background prefetch/generation runs detached from any request. An unhandled
  // rejection there must not take the server down mid-import.
  process.on("unhandledRejection", (reason) => {
    console.error("[unhandledRejection]", reason);
  });
  process.on("uncaughtException", (error) => {
    console.error("[uncaughtException]", error);
  });

  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || "0.0.0.0";
  const instance = createReadingServer();
  instance.listen(port, host).then((actualPort) => {
    console.log(`\n🚀 Progressive Reading API Server running at http://${host}:${actualPort}`);
    console.log(`Endpoints available:`);
    console.log(`  GET  /api/health`);
    console.log(`  GET  /api/books`);
    console.log(`  POST /api/books/upload`);
    console.log(`  GET  /api/books/:id/card`);
    console.log(`  POST /api/books/:id/advance`);
    console.log(`  GET  /api/widget/current`);
    console.log(`  POST /api/widget/advance`);
    console.log(`  POST /api/widget/rewind\n`);
  });
}
