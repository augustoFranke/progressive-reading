import { posix } from "node:path";
import { unzipSync } from "fflate";
import { asArray, attribute, parseXml } from "./xml.js";

export interface ExtractedCover {
  data: Uint8Array;
  mediaType: string;
}

const IMAGE_MEDIA_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/svg+xml",
]);

const EXTENSION_BY_MEDIA_TYPE: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
};

export function coverExtension(mediaType: string): string {
  return EXTENSION_BY_MEDIA_TYPE[mediaType.toLowerCase()] ?? "img";
}

export function isSupportedCoverMediaType(mediaType: string): boolean {
  return IMAGE_MEDIA_TYPES.has(mediaType.toLowerCase());
}

function normalizeHref(href: string): string {
  return decodeURIComponent(href.replace(/^\.?\//, ""));
}

function resolvePath(basePath: string, href: string): string {
  const withoutFragment = href.split("#", 1)[0];
  return posix.normalize(posix.join(posix.dirname(basePath), normalizeHref(withoutFragment)));
}

interface ManifestItem {
  id?: string;
  href?: string;
  mediaType?: string;
  properties?: string;
}

function readManifest(packageRecord: Record<string, unknown>): ManifestItem[] {
  const manifest = packageRecord.manifest as Record<string, unknown> | undefined;
  return asArray(manifest?.item).map((item) => ({
    id: attribute(item, "id"),
    href: attribute(item, "href"),
    mediaType: attribute(item, "media-type"),
    properties: attribute(item, "properties"),
  }));
}

/** `<meta name="cover" content="cover-id"/>` — the EPUB 2 way of naming a cover. */
function coverIdFromMetadata(packageRecord: Record<string, unknown>): string | undefined {
  const metadata = packageRecord.metadata as Record<string, unknown> | undefined;
  for (const meta of asArray(metadata?.meta)) {
    if (attribute(meta, "name")?.toLowerCase() === "cover") {
      const content = attribute(meta, "content");
      if (content) return content;
    }
  }
  return undefined;
}

/**
 * Resolves the cover in the order a reader app would: the EPUB 2 `<meta name="cover">`
 * pointer, then the EPUB 3 `properties="cover-image"` flag, then a name-based guess.
 * Publishers use all three, so a single strategy misses a large share of real books.
 */
function selectCoverHref(packageRecord: Record<string, unknown>): { href: string } | undefined {
  const items = readManifest(packageRecord);
  const images = items.filter(
    (item) => item.href && item.mediaType && isSupportedCoverMediaType(item.mediaType),
  );
  if (images.length === 0) return undefined;

  const declaredId = coverIdFromMetadata(packageRecord);
  if (declaredId) {
    const match = images.find((item) => item.id === declaredId);
    if (match?.href) return { href: match.href };
  }

  const flagged = images.find((item) =>
    item.properties?.split(/\s+/u).includes("cover-image"),
  );
  if (flagged?.href) return { href: flagged.href };

  const named = images.find(
    (item) => /cover/iu.test(item.id ?? "") || /cover/iu.test(item.href ?? ""),
  );
  if (named?.href) return { href: named.href };

  return undefined;
}

/**
 * Pulls the cover image out of an EPUB package. Returns null rather than throwing:
 * a book without a usable cover is normal, and must not fail an otherwise good ingest.
 */
export function extractCoverImage(epub: Uint8Array): ExtractedCover | null {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(epub);
  } catch {
    return null;
  }

  try {
    const containerXml = files["META-INF/container.xml"];
    if (!containerXml) return null;
    const container = parseXml(new TextDecoder().decode(containerXml));
    const rootfiles = (container.container as Record<string, unknown> | undefined)?.rootfiles as
      | Record<string, unknown>
      | undefined;
    const opfPath = attribute(asArray(rootfiles?.rootfile)[0], "full-path");
    if (!opfPath) return null;

    const normalizedOpfPath = normalizeHref(opfPath);
    const opfBytes = files[normalizedOpfPath];
    if (!opfBytes) return null;

    const opf = parseXml(new TextDecoder().decode(opfBytes));
    const packageRecord = opf.package as Record<string, unknown> | undefined;
    if (!packageRecord) return null;

    const selected = selectCoverHref(packageRecord);
    if (!selected) return null;

    const items = readManifest(packageRecord);
    const entryPath = resolvePath(normalizedOpfPath, selected.href);
    const data = files[entryPath];
    if (!data || data.length === 0) return null;

    const mediaType =
      items.find((item) => item.href && resolvePath(normalizedOpfPath, item.href) === entryPath)
        ?.mediaType ?? "image/jpeg";

    return { data, mediaType: mediaType.toLowerCase() };
  } catch {
    return null;
  }
}
