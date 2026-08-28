import type { Block, EvidenceLevel, Role, StructureKind, StructureNode } from "../core/types.js";

const APPARATUS_TITLE =
  /\b(introduction|preface|foreword|afterword|translator(?:'s|’s)? note|editor(?:'s|’s)? note|notes?|endnotes?|footnotes?|bibliography|bibliographical|chronology|glossary|index|acknowledg\w*|references(?: and abbreviations)?|works cited|minutes of|printer to the reader|argument)\b/i;
const FRONT_TITLE =
  /\b(title page|copyright|dedication|epigraph|contents|table of contents|list of illustrations|list of figures|preface|foreword|introduction|to the late)\b/i;
const BACK_TITLE =
  /\b(appendix|bibliography|glossary|index|acknowledg\w*|about the author|about the editors|other books by this author|editorial board)\b/i;
const PART_TITLE = /\b(part|book|volume)\b\s*[ivxlcdm0-9]*/i;
const WORK_TITLE = /\b(chapter|canto|stanza|act|scene|prologue|epilogue)\b/i;

function kindForHeading(text: string, level: number): StructureKind {
  if (PART_TITLE.test(text) && level <= 2) return "part";
  if (WORK_TITLE.test(text) || /^\s*[IVXLCDM]+\s*$/i.test(text)) return "chapter";
  return level <= 1 ? "chapter" : "section";
}

function roleForTitle(
  text: string,
  sourceRoleHint?: string,
): { role: Role; source: string; evidenceLevel: EvidenceLevel } {
  if (sourceRoleHint) {
    const hint = sourceRoleHint.toLowerCase();
    if (/frontmatter|preface|foreword|introduction|title-page|copyright/.test(hint)) {
      return { role: "front_matter", source: "epub-type", evidenceLevel: "high" };
    }
    if (/backmatter|endnote|footnote|bibliography|glossary|index|appendix/.test(hint)) {
      return { role: "apparatus", source: "epub-type", evidenceLevel: "high" };
    }
    if (/bodymatter|chapter|part|section/.test(hint)) {
      return { role: "work", source: "epub-type", evidenceLevel: "high" };
    }
  }
  if (BACK_TITLE.test(text) && !WORK_TITLE.test(text)) {
    return { role: "back_matter", source: "title-lexicon", evidenceLevel: "high" };
  }
  if (FRONT_TITLE.test(text)) {
    return { role: "front_matter", source: "title-lexicon", evidenceLevel: "high" };
  }
  if (APPARATUS_TITLE.test(text) && !WORK_TITLE.test(text)) {
    return { role: "apparatus", source: "title-lexicon", evidenceLevel: "high" };
  }
  if (WORK_TITLE.test(text) || PART_TITLE.test(text) || /^[IVXLCDM]+\.?$/i.test(text.trim())) {
    return { role: "work", source: "title-lexicon", evidenceLevel: "high" };
  }
  if (text.trim().length > 2 && text.trim() === text.trim().toUpperCase() && /[A-Z]/.test(text)) {
    return { role: "work", source: "uppercase-heading", evidenceLevel: "medium" };
  }
  return { role: "work", source: "default", evidenceLevel: "low" };
}

function closeNode(node: StructureNode, end: number): void {
  node.blockEnd = Math.max(node.blockStart, end);
}

export function detectStructure(blocks: Block[]): StructureNode[] {
  const headings = blocks.filter((block) => block.kind === "heading" && block.headingLevel);
  if (headings.length === 0) {
    return [
      {
        id: "node-0",
        kind: "chapter",
        ordinal: 0,
        title: "Untitled work",
        path: "Untitled work",
        blockStart: 0,
        blockEnd: blocks.length - 1,
        role: "work",
        roleSource: "fallback",
        detectionSource: "synthetic",
        evidenceLevel: "low",
        children: [],
      },
    ];
  }

  const roots: StructureNode[] = [];
  const stack: StructureNode[] = [];
  let ordinal = 0;

  for (const heading of headings) {
    const level = heading.headingLevel ?? 6;
    while (stack.length > 0 && (stack.at(-1)?.children.length ?? 0) >= 0 && (stack.at(-1) as StructureNode).detectionSource === "heading") {
      const current = stack.at(-1) as StructureNode;
      const currentLevel = Number(current.path.match(/^\[(\d+)\]/)?.[1] ?? 6);
      if (currentLevel < level) break;
      stack.pop();
      closeNode(current, heading.ordinal - 1);
    }

    const role = roleForTitle(heading.text, heading.sourceRoleHint);
    const node: StructureNode = {
      id: `node-${ordinal}`,
      kind: kindForHeading(heading.text, level),
      ordinal,
      title: heading.text,
      path: `[${level}] ${heading.text}`,
      blockStart: heading.ordinal,
      blockEnd: blocks.length - 1,
      role: role.role,
      roleSource: role.source,
      detectionSource: "heading",
      evidenceLevel: role.evidenceLevel,
      children: [],
    };
    ordinal += 1;

    while (stack.length > 0) {
      const parent = stack.at(-1) as StructureNode;
      const parentLevel = Number(parent.path.match(/^\[(\d+)\]/)?.[1] ?? 6);
      if (parentLevel < level) {
        node.parentId = parent.id;
        parent.children.push(node);
        break;
      }
      stack.pop();
      closeNode(parent, heading.ordinal - 1);
    }
    if (!node.parentId) roots.push(node);
    stack.push(node);
  }

  for (const node of stack) closeNode(node, blocks.length - 1);
  return roots;
}

function flatten(nodes: StructureNode[]): StructureNode[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children)]);
}

export function classifyStructureRoles(nodes: StructureNode[], blocks: Block[]): void {
  const allNodes = flatten(nodes).sort((a, b) => a.blockStart - b.blockStart);
  const firstExplicitWork = allNodes.findIndex((node) => node.role === "work" && node.roleSource !== "default");
  const hasExplicitApparatus = allNodes.some((node) => node.role === "apparatus" || node.role === "front_matter" || node.role === "back_matter");

  for (const [index, node] of allNodes.entries()) {
    if (node.roleSource === "default" && hasExplicitApparatus && firstExplicitWork >= 0 && index < firstExplicitWork) {
      node.role = "front_matter";
      node.roleSource = "position-before-work";
      node.evidenceLevel = "low";
    }
    if (node.parentId) {
      const parent = allNodes.find((candidate) => candidate.id === node.parentId);
      if (
        parent &&
        parent.role !== "work" &&
        parent.roleSource !== "position-before-work" &&
        node.roleSource !== "epub-type"
      ) {
        node.role = parent.role;
        node.roleSource = "inherited-parent";
        node.evidenceLevel = lowerEvidence(node.evidenceLevel, parent.evidenceLevel);
      }
    }
  }

  // Blocks before the first detected work heading are front matter only when the
  // edition has an explicit non-work node. Otherwise they remain part of the work.
  if (hasExplicitApparatus && firstExplicitWork >= 0) {
    const firstWorkStart = allNodes[firstExplicitWork].blockStart;
    for (const block of blocks) {
      if (block.ordinal >= firstWorkStart) break;
      if (block.kind === "furniture") continue;
      // The planner uses node roles for headed blocks. This loop intentionally only
      // documents the boundary for callers; blocks retain their canonical ordinals.
    }
  }

  // A short all-caps title immediately followed by explicit front matter is a
  // title page, not the beginning of the work. This is common in EPUBs whose
  // title page is encoded as a heading followed by another front-matter file.
  for (const [index, node] of allNodes.entries()) {
    const next = allNodes[index + 1];
    if (
      node.role === "work" &&
      node.roleSource === "uppercase-heading" &&
      node.blockEnd - node.blockStart <= 12 &&
      next?.role === "front_matter"
    ) {
      node.role = "front_matter";
      node.roleSource = "title-page-position";
      node.evidenceLevel = "high";
    }
  }
}

/**
 * An editorial heading such as "The Argument" can precede the actual verse
 * without having a following heading to close it. Keep that apparatus range
 * bounded at the first verse block so it cannot swallow the work below it.
 */
export function constrainApparatusBoundaries(nodes: StructureNode[], blocks: Block[]): void {
  for (const node of flattenStructure(nodes)) {
    if (node.role !== "apparatus") continue;
    const firstVerse = blocks.find(
      (block) => block.ordinal > node.blockStart && block.ordinal <= node.blockEnd && block.kind === "verse_line",
    );
    if (firstVerse) node.blockEnd = firstVerse.ordinal - 1;
  }
}

export function flattenStructure(nodes: StructureNode[]): StructureNode[] {
  return flatten(nodes);
}

function lowerEvidence(left: EvidenceLevel, right: EvidenceLevel): EvidenceLevel {
  if (left === "low" || right === "low") return "low";
  if (left === "medium" || right === "medium") return "medium";
  return "high";
}

export function structureNodeForBlock(
  nodes: StructureNode[],
  ordinal: number,
): StructureNode | undefined {
  const candidates = flatten(nodes)
    .filter((node) => ordinal >= node.blockStart && ordinal <= node.blockEnd)
    .sort((a, b) => b.blockStart - a.blockStart);
  return candidates[0];
}
