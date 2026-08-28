import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { Edition } from "../core/types.js";
import { ingestEpub } from "../ingest/epub.js";
import { planFragments, validateCoverage } from "../plan/fragments.js";
import {
  classifyStructureRoles,
  constrainApparatusBoundaries,
  detectStructure,
  flattenStructure,
} from "../plan/structure.js";

export const PIPELINE_VERSION = "ingest-epub-v1";

export async function ingestUpload(sourcePath: string): Promise<Edition> {
  const buffer = await readFile(sourcePath);
  const sourceFormat = detectSourceFormat(buffer, sourcePath);
  if (sourceFormat !== "epub") {
    throw new Error(`Unsupported source format for ${basename(sourcePath)}: ${sourceFormat}`);
  }

  const extracted = ingestEpub(buffer, sourcePath);
  const structure = detectStructure(extracted.blocks);
  classifyStructureRoles(structure, extracted.blocks);
  constrainApparatusBoundaries(structure, extracted.blocks);
  const fragments = planFragments(extracted.blocks, structure);
  const coverage = validateCoverage(extracted.blocks, fragments, structure);
  const errors = coverage.passed ? [] : ["Fragment plan does not cover work blocks exactly in order"];
  const allStructureNodes = flattenStructure(structure);
  const warnings = allStructureNodes
    .filter((node) => node.evidenceLevel === "low")
    .map((node) => `Low-evidence structure role: ${node.title}`);

  const quality = {
    status: errors.length > 0 ? "failed" as const : warnings.length > 0 ? "needs_review" as const : "ready" as const,
    errors,
    warnings,
    blockCount: extracted.blocks.length,
    workBlockCount: coverage.expectedBlockCount,
    structureNodeCount: allStructureNodes.length,
    fragmentCount: fragments.length,
    coverage,
  };

  return {
    pipelineVersion: PIPELINE_VERSION,
    sourceFormat,
    sourcePath,
    metadata: extracted.metadata,
    spine: extracted.spine,
    blocks: extracted.blocks,
    structure,
    fragments,
    quality,
  };
}

function detectSourceFormat(buffer: Uint8Array, sourcePath: string): "epub" | "pdf" | "unknown" {
  if (buffer[0] === 0x50 && buffer[1] === 0x4b) return "epub";
  if (buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46) return "pdf";
  const lower = sourcePath.toLowerCase();
  if (lower.endsWith(".epub")) return "epub";
  if (lower.endsWith(".pdf")) return "pdf";
  return "unknown";
}
