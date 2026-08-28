import { basename } from "node:path";
import { ingestUpload } from "./pipeline/ingestUpload.js";
import { generateFragment } from "./generate/generateFragment.js";
import { GeminiProvider } from "./generate/geminiProvider.js";
import type { GeneratedFragment } from "./generate/types.js";

const args = process.argv.slice(2);
const input = args.find((arg, index) =>
  !arg.startsWith("--") && !["--fragment", "--provider"].includes(args[index - 1] ?? ""),
);

if (!input) {
  console.error("Usage: npm run generate -- <path-to-epub> [--fragment <number>] [--provider local|gemini]");
  process.exitCode = 1;
} else {
  try {
    const fragmentNumber = parseFragmentNumber(args);
    const providerName = parseProvider(args);
    const edition = await ingestUpload(input);
    if (fragmentNumber > edition.fragments.length) {
      throw new Error(`Fragment ${fragmentNumber} does not exist; edition has ${edition.fragments.length} fragments`);
    }
    const provider = providerName === "gemini" ? new GeminiProvider() : undefined;
    const result = await generateFragment(edition, fragmentNumber - 1, provider);
    console.log(renderGeneratedFragment(result, fragmentNumber, edition.fragments.length, basename(input)));
    if (result.validation.status === "fail") process.exitCode = 2;
  } catch (error) {
    console.error(`${basename(input)}: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}

function parseProvider(args: string[]): "local" | "gemini" {
  const inline = args.find((arg) => arg.startsWith("--provider="));
  const separateIndex = args.indexOf("--provider");
  if (separateIndex >= 0 && (!args[separateIndex + 1] || args[separateIndex + 1].startsWith("--"))) {
    throw new Error("--provider requires local or gemini");
  }
  const value = inline?.slice("--provider=".length) ??
    (separateIndex >= 0 ? args[separateIndex + 1] : undefined) ??
    "local";
  if (value !== "local" && value !== "gemini") {
    throw new Error(`Provider must be local or gemini, received: ${value}`);
  }
  return value;
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
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new Error(`Fragment number must be a positive integer, received: ${value}`);
  }
  return number;
}

function renderGeneratedFragment(
  result: GeneratedFragment,
  fragmentNumber: number,
  fragmentCount: number,
  fileName: string,
): string {
  const { sourceSpan, rendition, validation } = result;
  const lines: string[] = [];
  lines.push(`GENERATE FRAGMENT ${fragmentNumber} / ${fragmentCount}`);
  lines.push(`File: ${fileName}`);
  lines.push(`Mode: ${sourceSpan.mode}`);
  lines.push(`Provider: ${rendition.providerId}`);
  lines.push(`Variant: ${rendition.variant}`);
  lines.push(`Source anchors: ${sourceSpan.startAnchor} → ${sourceSpan.endAnchor}`);
  lines.push(`Source words: ${validation.sourceWordCount}`);
  lines.push(`Rendition words: ${validation.renditionWordCount}`);
  lines.push(`Validation: ${validation.status}`);

  lines.push("");
  lines.push("SOURCE SPAN");
  lines.push("-----------");
  lines.push(sourceSpan.text);

  lines.push("");
  lines.push("RENDITION");
  lines.push("---------");
  lines.push(rendition.fragment);

  lines.push("");
  lines.push("EDITORIAL CHANGES");
  lines.push("-----------------");
  for (const change of rendition.editorialChanges) lines.push(`- ${change}`);

  lines.push("");
  lines.push("VALIDATION CHECKS");
  lines.push("-----------------");
  for (const check of validation.checks) {
    lines.push(`[${check.status.toUpperCase()}] ${check.id} ${check.label}: ${check.message}`);
  }

  if (rendition.nextFragmentBeginsWith) {
    lines.push("");
    lines.push(`NEXT FRAGMENT BEGINS: ${rendition.nextFragmentBeginsWith}`);
  }
  return `${lines.join("\n")}\n`;
}
