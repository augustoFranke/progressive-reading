import type { Block, Edition, StructureNode } from "./core/types.js";
import { flattenStructure, structureNodeForBlock } from "./plan/structure.js";

const WRAP_WIDTH = 100;

export function renderFragmentInspection(edition: Edition, fragmentIndex: number): string {
  const fragment = edition.fragments[fragmentIndex];
  if (!fragment) {
    throw new Error(`Fragment ${fragmentIndex} does not exist; edition has ${edition.fragments.length} fragments`);
  }

  const fragmentBlocks = edition.blocks.filter(
    (block) => block.ordinal >= fragment.blockStart && block.ordinal <= fragment.blockEnd,
  );
  const node = structureNodeForBlock(edition.structure, fragment.blockStart);
  const path = node ? structurePath(node, edition.structure).map((item) => item.title) : [];
  const lines: string[] = [];

  lines.push(`FRAGMENT ${fragment.globalIndex + 1} / ${edition.fragments.length}`);
  lines.push(`File: ${edition.sourcePath}`);
  lines.push(`Book: ${edition.metadata.title}${edition.metadata.author ? ` — ${edition.metadata.author}` : ""}`);
  lines.push(`Quality: ${edition.quality.status}`);
  lines.push(`Structure: ${path.length > 0 ? path.join(" / ") : "unheaded work"}`);
  lines.push(`Role: ${node?.role ?? "unassigned"}${node ? ` (evidence: ${node.evidenceLevel}, source: ${node.roleSource})` : ""}`);
  lines.push(`Mode: ${fragment.mode}`);
  lines.push(`Blocks: ${fragment.blockStart}–${fragment.blockEnd} (${fragmentBlocks.length})`);
  lines.push(`Source words: ${fragment.sourceWordCount}`);
  lines.push(`Estimated source reading time: ${formatDuration(fragment.targetReadSeconds)}`);
  lines.push(`Previous fragment: ${fragmentIndex > 0 ? fragmentIndex : "none"}`);
  lines.push(`Next fragment: ${fragmentIndex + 1 < edition.fragments.length ? fragmentIndex + 2 : "none"}`);

  const warnings = [...new Set(edition.quality.warnings)];
  if (warnings.length > 0) {
    lines.push("");
    lines.push("EDITION-WIDE QUALITY WARNINGS");
    for (const warning of warnings) lines.push(`- ${warning}`);
  }

  lines.push("");
  lines.push("BLOCKS");
  lines.push("------");
  for (const block of fragmentBlocks) {
    lines.push(...renderBlock(block, edition));
  }

  return `${lines.join("\n")}\n`;
}

function renderBlock(block: Block, edition: Edition): string[] {
  const node = structureNodeForBlock(edition.structure, block.ordinal);
  const role = node ? `${node.role}/${node.evidenceLevel}` : "unassigned";
  const source = block.sourceAnchor || block.sourceHref;
  const header = `[${String(block.ordinal).padStart(5, " ")}] ${block.kind.padEnd(12, " ")} role=${role} source=${source}`;
  const text = block.text.trim() || "(no text)";
  return [header, ...wrap(text).map((line) => `      ${line}`), ""];
}

function structurePath(node: StructureNode, structure: StructureNode[]): StructureNode[] {
  const allNodes = flattenStructure(structure);
  const byId = new Map(allNodes.map((candidate) => [candidate.id, candidate]));
  const path: StructureNode[] = [];
  let current: StructureNode | undefined = node;
  while (current) {
    path.unshift(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return path;
}

function wrap(text: string): string[] {
  const words = text.split(/\s+/u);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (current.length === 0) {
      current = word;
    } else if (current.length + word.length + 1 <= WRAP_WIDTH) {
      current += ` ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines;
}

function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}m ${String(remainder).padStart(2, "0")}s`;
}
