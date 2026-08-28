import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { ingestEpub } from "../src/ingest/epub.js";
import { planFragments, validateCoverage } from "../src/plan/fragments.js";
import { classifyStructureRoles, detectStructure, flattenStructure } from "../src/plan/structure.js";
import { ingestUpload } from "../src/pipeline/ingestUpload.js";
import { renderFragmentInspection } from "../src/inspect.js";

const root = resolve(import.meta.dirname, "..");
const fixtures = [
  "blood meridian.epub",
  "moby dick.epub",
  "paradise lost.epub",
  "the concept of anxiety.epub",
  "the divine comedy.epub",
];

describe("generalized EPUB ingestion", () => {
  it.each(fixtures)("ingests %s without title-specific configuration", async (fixture) => {
    const edition = await ingestUpload(resolve(root, fixture));
    expect(edition.sourceFormat).toBe("epub");
    expect(edition.metadata.title.length).toBeGreaterThan(0);
    expect(edition.spine.length).toBeGreaterThan(0);
    expect(edition.blocks.length).toBeGreaterThan(0);
    expect(edition.fragments.length).toBeGreaterThan(0);
    expect(edition.quality.coverage.passed).toBe(true);
    expect(edition.quality.errors).toEqual([]);
  });

  it("is deterministic for the same source", async () => {
    const path = resolve(root, fixtures[0]);
    const first = await ingestUpload(path);
    const second = await ingestUpload(path);
    expect(first.metadata).toEqual(second.metadata);
    expect(first.blocks).toEqual(second.blocks);
    expect(first.structure).toEqual(second.structure);
    expect(first.fragments).toEqual(second.fragments);
  });

  it("preserves ordered coverage without gaps or overlaps", async () => {
    const path = resolve(root, fixtures[1]);
    const edition = await ingestUpload(path);
    const coverage = validateCoverage(edition.blocks, edition.fragments, edition.structure);
    expect(coverage.passed).toBe(true);
    expect(coverage.plannedBlockCount).toBe(coverage.expectedBlockCount);
    for (let index = 1; index < edition.fragments.length; index += 1) {
      expect(edition.fragments[index].globalIndex).toBe(index);
      expect(edition.fragments[index].blockStart).toBeGreaterThan(edition.fragments[index - 1].blockEnd);
    }
  });

  it("does not create heading-only first fragments from duplicate navigation labels", async () => {
    for (const fixture of ["blood meridian.epub", "moby dick.epub"]) {
      const edition = await ingestUpload(resolve(root, fixture));
      expect(edition.fragments[0].sourceWordCount).toBeGreaterThan(500);
    }
  });

  it("detects verse blocks and assigns verse mode", async () => {
    const edition = await ingestUpload(resolve(root, "paradise lost.epub"));
    expect(edition.blocks.some((block) => block.kind === "verse_line")).toBe(true);
    expect(edition.fragments.some((fragment) => fragment.mode === "verse_verbatim")).toBe(true);
    expect(edition.quality.workBlockCount).toBeGreaterThan(10_000);

    const proseEdition = await ingestUpload(resolve(root, "moby dick.epub"));
    expect(proseEdition.blocks.some((block) => block.kind === "verse_line")).toBe(false);
  });

  it("keeps the core pipeline independent of the upload filename", async () => {
    const source = await readFile(resolve(root, "blood meridian.epub"));
    const first = ingestEpub(source, "first-upload.epub");
    const second = ingestEpub(source, "renamed-user-upload.epub");
    expect(first.metadata).toEqual(second.metadata);
    expect(first.blocks).toEqual(second.blocks);
  });

  it("uses an EPUB nav document when an NCX is not present", () => {
    const epub = zipSync({
      mimetype: strToU8("application/epub+zip"),
      "META-INF/container.xml": strToU8(
        '<?xml version="1.0"?><container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>',
      ),
      "book.opf": strToU8(
        '<package xmlns="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>Nav Fixture</dc:title></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="chapter" href="text/chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="chapter"/></spine></package>',
      ),
      "nav.xhtml": strToU8(
        '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol><li><a href="text/chapter.xhtml">Chapter One</a></li></ol></nav></body></html>',
      ),
      "text/chapter.xhtml": strToU8(
        '<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>Chapter One</h1><p>Readable content.</p></body></html>',
      ),
    });
    const edition = ingestEpub(epub, "nav-fixture.epub");
    expect(edition.spine[0].title).toBe("Chapter One");
    expect(edition.blocks.map((block) => block.text)).toEqual(["Chapter One", "Readable content."]);
  });

  it("classifies explicit apparatus headings without excluding the work", async () => {
    const edition = await ingestUpload(resolve(root, "the divine comedy.epub"));
    const nodes = flattenStructure(edition.structure);
    expect(nodes.some((node) => node.role === "apparatus")).toBe(true);
    expect(nodes.some((node) => node.role === "work")).toBe(true);
    expect(edition.quality.workBlockCount).toBeGreaterThan(0);
  });

  it("uses qualitative evidence levels instead of decimal confidence scores", async () => {
    const edition = await ingestUpload(resolve(root, "blood meridian.epub"));
    const levels = new Set(flattenStructure(edition.structure).map((node) => node.evidenceLevel));
    expect([...levels].every((level) => ["high", "medium", "low"].includes(level))).toBe(true);
  });

  it("renders a human-readable fragment inspection page", async () => {
    const edition = await ingestUpload(resolve(root, "blood meridian.epub"));
    const output = renderFragmentInspection(edition, 0);
    expect(output).toContain("FRAGMENT 1 /");
    expect(output).toContain("BLOCKS");
    expect(output).toContain("Source words:");
    expect(output).toContain("evidence:");
    expect(output).toContain(edition.blocks[edition.fragments[0].blockStart].sourceHref);
  });

  it("supports the pure structure and planning functions independently", async () => {
    const source = await readFile(resolve(root, "blood meridian.epub"));
    const extracted = ingestEpub(source);
    const structure = detectStructure(extracted.blocks);
    classifyStructureRoles(structure, extracted.blocks);
    const fragments = planFragments(extracted.blocks, structure);
    expect(validateCoverage(extracted.blocks, fragments, structure).passed).toBe(true);
  });
});
