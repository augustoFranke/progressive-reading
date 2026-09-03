import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Edition } from "../core/types.js";
import type { GeneratedFragment } from "../generate/types.js";
import { coverExtension } from "../ingest/cover.js";
import type { ReaderSession, StoredFragmentRecord } from "./types.js";

const DEFAULT_CACHE_DIR = resolve(process.cwd(), ".cache", "progressive-reading");

export function getEditionId(edition: Edition): string {
  const title = edition.metadata?.title?.trim();
  if (title) return sanitizeFilename(title);
  const base = edition.sourcePath ? edition.sourcePath.split(/[/\\]/u).pop() ?? "edition" : "edition";
  return sanitizeFilename(base);
}

export class EditionStorage {
  readonly baseDir: string;

  constructor(baseDir: string = process.env.PROGRESSIVE_READING_CACHE_DIR || DEFAULT_CACHE_DIR) {
    this.baseDir = resolve(baseDir);
  }

  private getEditionPath(editionId: string): string {
    return join(this.baseDir, "editions", `${sanitizeFilename(editionId)}.json`);
  }

  private getFragmentPath(editionId: string, fragmentIndex: number): string {
    return join(this.baseDir, "editions", sanitizeFilename(editionId), "fragments", `${fragmentIndex}.json`);
  }

  private getSessionPath(editionId: string): string {
    return join(this.baseDir, "sessions", `${sanitizeFilename(editionId)}.json`);
  }

  async saveEdition(edition: Edition, explicitId?: string): Promise<string> {
    const editionId = explicitId ?? getEditionId(edition);
    const filePath = this.getEditionPath(editionId);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify(edition, null, 2), "utf-8");
    return editionId;
  }

  async getEdition(editionId: string): Promise<Edition | null> {
    const filePath = this.getEditionPath(editionId);
    try {
      const content = await readFile(filePath, "utf-8");
      return JSON.parse(content) as Edition;
    } catch {
      return null;
    }
  }

  async hasEdition(editionId: string): Promise<boolean> {
    const filePath = this.getEditionPath(editionId);
    try {
      await stat(filePath);
      return true;
    } catch {
      return false;
    }
  }

  async saveFragment(editionId: string, fragmentIndex: number, fragment: GeneratedFragment): Promise<void> {
    const filePath = this.getFragmentPath(editionId, fragmentIndex);
    await mkdir(dirname(filePath), { recursive: true });
    const record: StoredFragmentRecord = {
      editionId,
      fragmentIndex,
      fragmentId: fragment.sourceSpan.fragment.id,
      generated: fragment,
      storedAt: new Date().toISOString(),
    };
    await writeFile(filePath, JSON.stringify(record, null, 2), "utf-8");
  }

  async getFragment(editionId: string, fragmentIndex: number): Promise<GeneratedFragment | null> {
    const filePath = this.getFragmentPath(editionId, fragmentIndex);
    try {
      const content = await readFile(filePath, "utf-8");
      const record = JSON.parse(content) as StoredFragmentRecord;
      return record.generated;
    } catch {
      return null;
    }
  }

  async hasFragment(editionId: string, fragmentIndex: number): Promise<boolean> {
    const filePath = this.getFragmentPath(editionId, fragmentIndex);
    try {
      await stat(filePath);
      return true;
    } catch {
      return false;
    }
  }

  async saveSession(session: ReaderSession): Promise<void> {
    const filePath = this.getSessionPath(session.editionId);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify(session, null, 2), "utf-8");
  }

  async getSession(editionId: string): Promise<ReaderSession | null> {
    const filePath = this.getSessionPath(editionId);
    try {
      const content = await readFile(filePath, "utf-8");
      return JSON.parse(content) as ReaderSession;
    } catch {
      return null;
    }
  }

  private getCoverDir(editionId: string): string {
    return join(this.baseDir, "editions", sanitizeFilename(editionId));
  }

  /** Covers are stored beside the edition, named by media type so the extension is recoverable. */
  async saveCover(editionId: string, data: Uint8Array, mediaType: string): Promise<void> {
    const filePath = join(this.getCoverDir(editionId), `cover.${coverExtension(mediaType)}`);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, data);
  }

  async getCover(editionId: string): Promise<{ data: Buffer; mediaType: string } | null> {
    const dir = this.getCoverDir(editionId);
    for (const [mediaType, ext] of COVER_LOOKUP) {
      const filePath = join(dir, `cover.${ext}`);
      try {
        return { data: await readFile(filePath), mediaType };
      } catch {
        continue;
      }
    }
    return null;
  }

  async hasCover(editionId: string): Promise<boolean> {
    const dir = this.getCoverDir(editionId);
    for (const [, ext] of COVER_LOOKUP) {
      try {
        await stat(join(dir, `cover.${ext}`));
        return true;
      } catch {
        continue;
      }
    }
    return false;
  }

  async clearEdition(editionId: string): Promise<void> {
    const editionDir = join(this.baseDir, "editions", sanitizeFilename(editionId));
    const editionFile = this.getEditionPath(editionId);
    const sessionFile = this.getSessionPath(editionId);
    await rm(editionDir, { recursive: true, force: true }).catch(() => {});
    await rm(editionFile, { force: true }).catch(() => {});
    await rm(sessionFile, { force: true }).catch(() => {});
  }
}

const COVER_LOOKUP: ReadonlyArray<readonly [string, string]> = [
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/webp", "webp"],
  ["image/gif", "gif"],
  ["image/svg+xml", "svg"],
];

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/gu, "_");
}
