import { posix } from "node:path";
import { unzipSync, strFromU8 } from "fflate";
import { parseFragment } from "parse5";
import type {
  Block,
  BlockKind,
  BookMetadata,
  SpineDocument,
} from "../core/types.js";
import { asArray, attribute, parseXml, textValue } from "./xml.js";

interface DomNode {
  nodeName?: string;
  tagName?: string;
  value?: string;
  childNodes?: DomNode[];
  attrs?: Array<{ name: string; value: string }>;
}

interface ParsedEpub {
  metadata: BookMetadata;
  spine: SpineDocument[];
  blocks: Block[];
}

interface NavigationEntry {
  href: string;
  title: string;
}

const BLOCK_TAGS = new Set([
  "address",
  "article",
  "blockquote",
  "dd",
  "details",
  "figcaption",
  "figure",
  "li",
  "p",
  "pre",
  "summary",
]);

const APPARATUS_WORDS =
  /\b(introduction|preface|foreword|afterword|translator(?:'s|’s)? note|editor(?:'s|’s)? note|notes?|endnotes?|footnotes?|bibliography|bibliographical|chronology|glossary|index|acknowledg|argument)\b/i;
const FRONT_MATTER_WORDS =
  /\b(title page|copyright|dedication|epigraph|contents|table of contents|preface|foreword|introduction)\b/i;

function normalizeHref(href: string): string {
  return decodeURIComponent(href.replace(/^\.?\//, ""));
}

function resolvePath(basePath: string, href: string): string {
  const withoutFragment = href.split("#", 1)[0];
  return posix.normalize(posix.join(posix.dirname(basePath), normalizeHref(withoutFragment)));
}

function zipText(files: Record<string, Uint8Array>, path: string): string {
  const bytes = files[path];
  if (!bytes) throw new Error(`EPUB entry not found: ${path}`);
  return strFromU8(bytes);
}

function attr(node: DomNode, name: string): string | undefined {
  return node.attrs?.find((entry) => entry.name === name)?.value;
}

function children(node: DomNode): DomNode[] {
  return node.childNodes ?? [];
}

function tag(node: DomNode): string {
  return (node.tagName ?? node.nodeName ?? "").toLowerCase();
}

function classAndType(node: DomNode): string {
  return `${attr(node, "class") ?? ""} ${attr(node, "epub:type") ?? ""} ${
    attr(node, "type") ?? ""
  }`.toLowerCase();
}

function hasDescendantTag(node: DomNode, tags: Set<string>): boolean {
  for (const child of children(node)) {
    const childTag = tag(child);
    if (tags.has(childTag)) return true;
    if (hasDescendantTag(child, tags)) return true;
  }
  return false;
}

function countDescendantTag(node: DomNode, wantedTag: string): number {
  return children(node).reduce(
    (count, child) => count + (tag(child) === wantedTag ? 1 : 0) + countDescendantTag(child, wantedTag),
    0,
  );
}

function textWithBreaks(node: DomNode): string {
  if (node.nodeName === "#text") return node.value ?? "";
  if (tag(node) === "br") return "\n";
  return children(node).map(textWithBreaks).join("");
}

function normalizeText(value: string): string {
  return value
    .replace(/\u00a0/g, " ")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function wordCount(text: string): number {
  return text.trim() === "" ? 0 : text.trim().split(/\s+/u).length;
}

function isVerse(node: DomNode, text: string): boolean {
  const marker = classAndType(node);
  if (/(titlepage|title-page|\bfm[-_]|copy-text|epi-line|fnote-|endnote-)/u.test(marker)) {
    return false;
  }
  if (/\b(verse|poem|stanza|atx1|hanging\w*|z3998:verse|z3998:poem)\b/u.test(marker)) {
    return true;
  }

  if (tag(node) === "div" && hasDescendantTag(node, BLOCK_TAGS)) return false;
  if (countDescendantTag(node, "br") < 2) return false;
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length < 5 || !lines.every((line) => wordCount(line) <= 18)) return false;
  const lengths = lines.map(wordCount);
  const average = lengths.reduce((sum, length) => sum + length, 0) / lengths.length;
  const spread = Math.max(...lengths) - Math.min(...lengths);
  return spread <= Math.max(5, average * 0.75);
}

function isFurniture(node: DomNode): boolean {
  return /\b(header|footer|running-head|page-header|page-footer|ornament)\b/u.test(
    classAndType(node),
  );
}

function isFootnote(node: DomNode): boolean {
  return /\b(footnote|endnote|rearnote|note)\b/u.test(classAndType(node));
}

function kindForElement(node: DomNode): BlockKind {
  const elementTag = tag(node);
  if (elementTag === "blockquote") return "blockquote";
  if (elementTag === "li") return "list_item";
  if (elementTag === "figcaption") return "caption";
  if (elementTag === "figure") return "figure";
  if (elementTag === "epigraph") return "epigraph";
  if (isFootnote(node)) return "footnote";
  if (isFurniture(node)) return "furniture";
  return "paragraph";
}

function roleHintForNode(node: DomNode, inherited?: string): string | undefined {
  return attr(node, "epub:type") ?? attr(node, "type") ?? inherited;
}

function headingLevel(node: DomNode): number | undefined {
  const match = /^h([1-6])$/u.exec(tag(node));
  return match ? Number(match[1]) : undefined;
}

function titleFromHeading(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

function detectDrm(files: Record<string, Uint8Array>): void {
  if (files["META-INF/rights.xml"] || files["META-INF/sinf.xml"]) {
    throw new Error("EPUB contains rights.xml or sinf.xml and may be DRM-protected");
  }

  const encryption = files["META-INF/encryption.xml"];
  if (!encryption) return;

  const xml = strFromU8(encryption);
  const references = [...xml.matchAll(/CipherReference[^>]+URI=["']([^"']+)["']/giu)].map(
    (match) => decodeURIComponent(match[1]),
  );
  const fontOnly = references.length > 0 && references.every((reference) =>
    /(^|\/)(fonts?|font-obfuscation)(\/|$)/iu.test(reference),
  );
  if (!fontOnly) {
    throw new Error("EPUB encryption.xml references content outside font obfuscation");
  }
}

function parseContainer(files: Record<string, Uint8Array>): string {
  const container = parseXml(zipText(files, "META-INF/container.xml"));
  const rootfiles = (container.container as Record<string, unknown> | undefined)?.rootfiles as
    | Record<string, unknown>
    | undefined;
  const rootfile = asArray(rootfiles?.rootfile)[0];
  const path = attribute(rootfile, "full-path");
  if (!path) throw new Error("EPUB container.xml has no rootfile full-path");
  return normalizeHref(path);
}

function parseMetadata(opf: Record<string, unknown>): BookMetadata {
  const metadata = opf.package && typeof opf.package === "object"
    ? (opf.package as Record<string, unknown>).metadata
    : undefined;
  const record = metadata && typeof metadata === "object" ? metadata as Record<string, unknown> : {};
  const title = textValue(record["dc:title"])?.trim();
  if (!title) throw new Error("EPUB metadata has no dc:title");
  const author = textValue(record["dc:creator"])?.trim();
  const language = textValue(record["dc:language"])?.trim();
  return { title, ...(author ? { author } : {}), ...(language ? { language } : {}) };
}

function parseSpine(
  opf: Record<string, unknown>,
  opfPath: string,
  files: Record<string, Uint8Array>,
): SpineDocument[] {
  const packageRecord = opf.package as Record<string, unknown>;
  const manifest = packageRecord.manifest as Record<string, unknown> | undefined;
  const spine = packageRecord.spine as Record<string, unknown> | undefined;
  const manifestItems = new Map<string, Record<string, unknown>>();
  for (const item of asArray(manifest?.item)) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const id = attribute(record, "id");
    if (id) manifestItems.set(id, record);
  }

  const navigation = parseNavigation(packageRecord, manifestItems, opfPath, files);
  const result: SpineDocument[] = [];
  for (const [index, item] of asArray(spine?.itemref).entries()) {
    const idref = attribute(item, "idref");
    if (!idref || attribute(item, "linear") === "no") continue;
    const manifestItem = manifestItems.get(idref);
    if (!manifestItem) throw new Error(`EPUB spine references missing manifest item: ${idref}`);
    const href = attribute(manifestItem, "href");
    const mediaType = attribute(manifestItem, "media-type");
    if (!href || mediaType !== "application/xhtml+xml") continue;
    result.push({
      index: result.length,
      id: idref,
      href: resolvePath(opfPath, href),
      mediaType,
      ...(navigation.get(resolvePath(opfPath, href))
        ? { title: navigation.get(resolvePath(opfPath, href)) }
        : {}),
    });
  }
  if (result.length === 0) throw new Error("EPUB spine contains no XHTML reading documents");
  return result;
}

function parseNavigation(
  packageRecord: Record<string, unknown>,
  manifestItems: Map<string, Record<string, unknown>>,
  opfPath: string,
  files: Record<string, Uint8Array>,
): Map<string, string> {
  const spine = packageRecord.spine as Record<string, unknown> | undefined;
  const tocId = attribute(spine, "toc");
  const tocItem = (tocId ? manifestItems.get(tocId) : undefined) ??
    [...manifestItems.values()].find((item) => attribute(item, "media-type") === "application/x-dtbncx+xml");
  const tocHref = tocItem && attribute(tocItem, "href");
  if (!tocHref) {
    const navItem = [...manifestItems.values()].find((item) => {
      const properties = attribute(item, "properties") ?? "";
      const href = attribute(item, "href") ?? "";
      return /\bnav\b/iu.test(properties) || /(^|\/)nav(?:igation)?(?:\.[^.]+)?\.x?html$/iu.test(href);
    });
    const navHref = navItem && attribute(navItem, "href");
    if (!navHref) return new Map();
    const navPath = resolvePath(opfPath, navHref);
    return parseNavXhtml(navPath, zipText(files, navPath));
  }

  const tocPath = resolvePath(opfPath, tocHref);
  const parsed = parseXml(zipText(files, tocPath));
  const ncx = parsed.ncx as Record<string, unknown> | undefined;
  const navMap = ncx?.navMap as Record<string, unknown> | undefined;
  const result = new Map<string, string>();

  const visit = (value: unknown): void => {
    for (const item of asArray(value)) {
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      const content = record.content;
      const source = attribute(content, "src");
      const label = record.navLabel && typeof record.navLabel === "object"
        ? textValue((record.navLabel as Record<string, unknown>).text)
        : undefined;
      if (source && label) {
        result.set(resolvePath(tocPath, source), label.trim());
      }
      visit(record.navPoint);
    }
  };
  visit(navMap?.navPoint);
  return result;
}

function parseNavXhtml(navPath: string, html: string): Map<string, string> {
  const root = parseFragment(html) as unknown as DomNode;
  const result = new Map<string, string>();
  let foundToc = false;

  const visit = (node: DomNode, inToc: boolean): void => {
    const marker = classAndType(node);
    const isToc = inToc || (tag(node) === "nav" && /\btoc\b/u.test(marker));
    if (isToc) foundToc = true;
    if (tag(node) === "a") {
      const href = attr(node, "href");
      const title = normalizeText(textWithBreaks(node));
      if (href && title && (isToc || !foundToc)) {
        result.set(resolvePath(navPath, href), title);
      }
    }
    for (const child of children(node)) visit(child, isToc);
  };

  for (const child of children(root)) visit(child, false);
  return result;
}

function emitBlocks(
  html: string,
  documentHref: string,
  spineIndex: number,
): Block[] {
  const output: Block[] = [];
  const root = parseFragment(html) as unknown as DomNode;
  let printPage: number | undefined;
  let stanzaCounter = 0;

  const emit = (
    node: DomNode,
    kind: BlockKind,
    text: string,
    level?: number,
    stanzaId?: string,
    sourceRoleHint?: string,
  ): void => {
    const normalized = normalizeText(text);
    if (!normalized) return;
    const ordinal = output.length;
    output.push({
      ordinal,
      spineIndex,
      sourceHref: documentHref,
      sourceAnchor: `${documentHref}#block-${ordinal}`,
      kind,
      text: normalized,
      ...(sourceRoleHint ? { sourceRoleHint } : {}),
      ...(level ? { headingLevel: level } : {}),
      ...(stanzaId ? { stanzaId } : {}),
      ...(printPage !== undefined ? { printPage } : {}),
    });
  };

  const walk = (node: DomNode, inheritedRoleHint?: string): void => {
    const elementTag = tag(node);
    const sourceRoleHint = roleHintForNode(node, inheritedRoleHint);
    const pageAnchor = attr(node, "id")?.match(/^page(\d+)$/iu);
    if (elementTag === "a" && pageAnchor) {
      printPage = Number(pageAnchor[1]);
    }

    const level = headingLevel(node);
    if (level) {
      emit(node, "heading", titleFromHeading(textWithBreaks(node)), level, undefined, sourceRoleHint);
      return;
    }

    if (elementTag === "br" || elementTag === "img" || elementTag === "a") {
      for (const child of children(node)) walk(child, sourceRoleHint);
      return;
    }

    const rawText = textWithBreaks(node);
    const normalized = normalizeText(rawText);
    const verse = isVerse(node, rawText);
    const blockLike = BLOCK_TAGS.has(elementTag);
    const hasNestedBlock = hasDescendantTag(
      node,
      new Set(["address", "blockquote", "dd", "figcaption", "figure", "h1", "h2", "h3", "h4", "h5", "h6", "li", "p", "pre"]),
    );

    if (verse) {
      stanzaCounter += 1;
      const stanzaId = `stanza-${spineIndex}-${stanzaCounter}`;
      for (const line of normalized.split("\n").map((value) => value.trim()).filter(Boolean)) {
        emit(node, "verse_line", line, undefined, stanzaId);
      }
      return;
    }

    if (blockLike && normalized && !hasNestedBlock) {
      emit(node, kindForElement(node), normalized, undefined, undefined, sourceRoleHint);
      return;
    }

    if (elementTag === "div" && normalized && !hasNestedBlock) {
      emit(node, isFootnote(node) ? "footnote" : "paragraph", normalized, undefined, undefined, sourceRoleHint);
      return;
    }

    for (const child of children(node)) walk(child, sourceRoleHint);
  };

  for (const child of children(root)) walk(child);
  return output;
}

function reindexBlocks(blocks: Block[]): Block[] {
  return blocks.map((block, ordinal) => ({
    ...block,
    ordinal,
    sourceAnchor: `${block.sourceHref}#block-${ordinal}`,
  }));
}

function headingKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/\b(chapter|canto|book|part|volume)\b/gu, "")
    .replace(/[^a-z0-9]+/gu, "");
}

export function ingestEpub(buffer: Uint8Array, sourcePath = "upload.epub"): ParsedEpub {
  const files = unzipSync(buffer);
  const mimetype = files.mimetype ? strFromU8(files.mimetype) : undefined;
  if (mimetype !== "application/epub+zip") {
    throw new Error("EPUB mimetype must be application/epub+zip");
  }
  detectDrm(files);

  const opfPath = parseContainer(files);
  const opf = parseXml(zipText(files, opfPath));
  const metadata = parseMetadata(opf);
  const spine = parseSpine(opf, opfPath, files);
  const blocks: Block[] = [];

  for (const document of spine) {
    const documentBlocks = emitBlocks(zipText(files, document.href), document.href, document.index);
    const documentHeadings = documentBlocks.filter((block) => block.kind === "heading");
    const navTitle = document.title?.trim();
    const matchingHeading = navTitle && documentHeadings.some((block) =>
      headingKey(block.text) === headingKey(navTitle),
    );
    if (navTitle && !matchingHeading) {
      documentBlocks.unshift({
        ordinal: 0,
        spineIndex: document.index,
        sourceHref: document.href,
        sourceAnchor: `${document.href}#nav-heading`,
        kind: "heading",
        text: navTitle,
        headingLevel: /\b(part|book|volume|chapter|canto|act|scene)\b/i.test(navTitle) ? 1 : 2,
      });
    }
    blocks.push(...documentBlocks);
  }

  if (blocks.length === 0) throw new Error("EPUB produced no readable blocks");
  return { metadata, spine, blocks: reindexBlocks(blocks) };
}
