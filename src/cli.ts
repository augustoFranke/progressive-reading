import { basename } from "node:path";
import { ingestUpload } from "./pipeline/ingestUpload.js";

const input = process.argv[2];
if (!input) {
  console.error("Usage: npm run ingest -- <path-to-epub>");
  process.exitCode = 1;
} else {
  try {
    const edition = await ingestUpload(input);
    console.log(JSON.stringify({
      file: basename(input),
      metadata: edition.metadata,
      spineDocuments: edition.spine.length,
      blocks: edition.blocks.length,
      structure: edition.structure.map((node) => ({
        title: node.title,
        kind: node.kind,
        role: node.role,
        evidenceLevel: node.evidenceLevel,
        blockStart: node.blockStart,
        blockEnd: node.blockEnd,
        children: node.children.length,
      })),
      fragments: edition.fragments.length,
      quality: edition.quality,
      firstFragment: edition.fragments[0],
    }, null, 2));
    if (edition.quality.status === "failed") process.exitCode = 2;
  } catch (error) {
    console.error(`${basename(input)}: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}
