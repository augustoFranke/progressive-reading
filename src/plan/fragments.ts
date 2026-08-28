import type { Block, FragmentMode, FragmentPlan, StructureNode } from "../core/types.js";
import { flattenStructure, structureNodeForBlock } from "./structure.js";

export interface FragmentPlanParams {
  minSourceWords?: number;
  targetSourceWords?: number;
  maxSourceWords?: number;
  proseWordsPerMinute?: number;
  verseWordsPerMinute?: number;
  planVersion?: string;
}

const DEFAULTS: Required<FragmentPlanParams> = {
  minSourceWords: 1100,
  targetSourceWords: 1350,
  maxSourceWords: 1600,
  proseWordsPerMinute: 220,
  verseWordsPerMinute: 145,
  planVersion: "fragment-plan-v1",
};

function words(text: string): number {
  return text.trim() === "" ? 0 : text.trim().split(/\s+/u).length;
}

function modeFor(blocks: Block[]): FragmentMode {
  return blocks.some((block) => block.kind === "verse_line") ? "verse_verbatim" : "prose_compressed";
}

function workNode(
  node: StructureNode | undefined,
  ordinal: number,
  structure: StructureNode[],
): boolean {
  if (node) return node.role === "work";
  const allNodes = flattenStructure(structure);
  const hasNonWork = allNodes.some((candidate) => candidate.role !== "work");
  const firstWorkStart = allNodes
    .filter((candidate) => candidate.role === "work")
    .map((candidate) => candidate.blockStart)
    .sort((a, b) => a - b)[0];
  return !hasNonWork || firstWorkStart === undefined || ordinal >= firstWorkStart;
}

function planningNodeForBlock(
  structure: StructureNode[],
  ordinal: number,
): StructureNode | undefined {
  const node = structureNodeForBlock(structure, ordinal);
  if (node && node.children.length > 0 && ordinal < node.children[0].blockStart) {
    return node.children[0];
  }
  return node;
}

export function planFragments(
  blocks: Block[],
  structure: StructureNode[],
  params: FragmentPlanParams = {},
): FragmentPlan[] {
  const config = { ...DEFAULTS, ...params };
  const workBlocks = blocks.filter((block) =>
    workNode(structureNodeForBlock(structure, block.ordinal), block.ordinal, structure),
  );
  if (workBlocks.length === 0) return [];

  const result: FragmentPlan[] = [];
  let current: Block[] = [];
  let currentNode: StructureNode | undefined;
  let nodeIndex = 0;
  let previousBlock: Block | undefined;

  const flush = (): void => {
    if (current.length === 0) return;
    const mode = modeFor(current);
    const sourceWordCount = current.reduce((sum, block) => sum + words(block.text), 0);
    const wpm = mode === "verse_verbatim" ? config.verseWordsPerMinute : config.proseWordsPerMinute;
    result.push({
      id: `fragment-${result.length}`,
      nodeId: currentNode?.id ?? "node-unheaded-work",
      indexInNode: nodeIndex,
      globalIndex: result.length,
      mode,
      blockStart: current[0].ordinal,
      blockEnd: current.at(-1)?.ordinal ?? current[0].ordinal,
      sourceWordCount,
      targetReadSeconds: Math.max(1, Math.ceil((sourceWordCount / wpm) * 60)),
    });
    current = [];
    nodeIndex += 1;
  };

  for (const block of workBlocks) {
    const node = planningNodeForBlock(structure, block.ordinal);
    const nodeChanged = currentNode && node && currentNode.id !== node.id;
    const excludedGap = previousBlock && block.ordinal > previousBlock.ordinal + 1 && current.length > 0;
    const currentWords = current.reduce((sum, item) => sum + words(item.text), 0);
    const nextWords = currentWords + words(block.text);
    if (nodeChanged || excludedGap) flush();
    if (current.length > 0 && nextWords > config.maxSourceWords && currentWords >= config.minSourceWords) {
      flush();
    }
    if (!currentNode || nodeChanged) {
      currentNode = node;
      nodeIndex = 0;
    }
    current.push(block);
    previousBlock = block;
    const afterAddWords = current.reduce((sum, item) => sum + words(item.text), 0);
    if (afterAddWords >= config.targetSourceWords) flush();
  }
  flush();

  return result;
}

export function validateCoverage(
  blocks: Block[],
  fragments: FragmentPlan[],
  structure: StructureNode[],
): { passed: boolean; expectedBlockCount: number; plannedBlockCount: number } {
  const expected = blocks.filter((block) =>
    workNode(structureNodeForBlock(structure, block.ordinal), block.ordinal, structure),
  );
  const planned = fragments.flatMap((fragment) =>
    blocks.filter((block) =>
      block.ordinal >= fragment.blockStart &&
      block.ordinal <= fragment.blockEnd &&
      workNode(structureNodeForBlock(structure, block.ordinal), block.ordinal, structure),
    ),
  );
  const expectedOrdinals = expected.map((block) => block.ordinal);
  const plannedOrdinals = planned.map((block) => block.ordinal);
  const passed =
    expectedOrdinals.length === plannedOrdinals.length &&
    expectedOrdinals.every((ordinal, index) => ordinal === plannedOrdinals[index]);
  return {
    passed,
    expectedBlockCount: expectedOrdinals.length,
    plannedBlockCount: plannedOrdinals.length,
  };
}
