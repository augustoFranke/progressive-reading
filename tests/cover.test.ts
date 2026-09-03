import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { coverExtension, extractCoverImage, isSupportedCoverMediaType } from "../src/ingest/cover.js";

const CORPUS = [
  "moby dick.epub",
  "blood meridian.epub",
  "paradise lost.epub",
  "the divine comedy.epub",
  "the concept of anxiety.epub",
];

/** Magic bytes, so a "cover" that is actually XML or an empty entry cannot pass. */
function sniff(data: Uint8Array): string | null {
  if (data[0] === 0xff && data[1] === 0xd8) return "image/jpeg";
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return "image/png";
  if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) return "image/gif";
  const head = new TextDecoder().decode(data.slice(0, 6)).toLowerCase();
  if (head.startsWith("<svg") || head.startsWith("<?xml")) return "image/svg+xml";
  return null;
}

describe("extractCoverImage", () => {
  it.each(CORPUS)("returns real image bytes for %s", async (file) => {
    const cover = extractCoverImage(await readFile(file));

    expect(cover).not.toBeNull();
    expect(cover!.data.length).toBeGreaterThan(1024);
    expect(isSupportedCoverMediaType(cover!.mediaType)).toBe(true);

    // The declared media type must match what the bytes actually are.
    expect(sniff(cover!.data)).toBe(
      cover!.mediaType === "image/jpg" ? "image/jpeg" : cover!.mediaType,
    );
  });

  it("returns null for a non-zip payload instead of throwing", () => {
    expect(extractCoverImage(new TextEncoder().encode("not an epub at all"))).toBeNull();
  });

  it("returns null for a zip that is not an EPUB", async () => {
    // A valid EPUB is a zip; a zip without container.xml must be rejected, not guessed at.
    const { zipSync } = await import("fflate");
    const bogus = zipSync({ "hello.txt": new TextEncoder().encode("hi") });
    expect(extractCoverImage(bogus)).toBeNull();
  });

  it("maps media types to the extension used for storage", () => {
    expect(coverExtension("image/jpeg")).toBe("jpg");
    expect(coverExtension("image/png")).toBe("png");
    expect(coverExtension("application/octet-stream")).toBe("img");
  });
});
