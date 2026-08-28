import { basename } from "node:path";
import { ingestUpload } from "./pipeline/ingestUpload.js";
import { renderFragmentInspection } from "./inspect.js";

const args = process.argv.slice(2);
const input = args.find((arg, index) =>
  !arg.startsWith("--") && args[index - 1] !== "--fragment",
);

if (!input) {
  console.error("Usage: npm run inspect -- <path-to-epub> [--fragment <index>]");
  process.exitCode = 1;
} else {
  try {
    const fragmentNumber = parseFragmentNumber(args);
    const edition = await ingestUpload(input);
    if (fragmentNumber > edition.fragments.length) {
      throw new Error(`Fragment ${fragmentNumber} does not exist; edition has ${edition.fragments.length} fragments`);
    }
    console.log(renderFragmentInspection(edition, fragmentNumber - 1));
    if (edition.quality.status === "failed") process.exitCode = 2;
  } catch (error) {
    console.error(`${basename(input)}: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}

function parseFragmentNumber(args: string[]): number {
  const inline = args.find((arg) => arg.startsWith("--fragment="));
  const separateIndex = args.indexOf("--fragment");
  if (separateIndex >= 0 && (!args[separateIndex + 1] || args[separateIndex + 1].startsWith("--"))) {
    throw new Error("--fragment requires a positive integer value");
  }
  const value = inline?.slice("--fragment=".length) ??
    (separateIndex >= 0 ? args[separateIndex + 1] : undefined) ??
    "1";
  const index = Number(value);
  if (!Number.isInteger(index) || index < 1) {
    throw new Error(`Fragment number must be a positive integer, received: ${value}`);
  }
  return index;
}
