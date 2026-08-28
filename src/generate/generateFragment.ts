import type { Edition } from "../core/types.js";
import { LocalDraftProvider } from "./localProvider.js";
import { buildSourceSpan } from "./sourceSpan.js";
import type { GeneratedFragment, GenerationProvider, ValidationContext } from "./types.js";
import { validateRendition } from "./validators.js";

export interface GenerateFragmentOptions extends ValidationContext {}

export async function generateFragment(
  edition: Edition,
  fragmentIndex: number,
  provider: GenerationProvider = new LocalDraftProvider(),
  options: GenerateFragmentOptions = {},
): Promise<GeneratedFragment> {
  const sourceSpan = buildSourceSpan(edition, fragmentIndex);
  const nextFragment = edition.fragments[fragmentIndex + 1];
  const nextBlock = nextFragment
    ? edition.blocks.find((block) => block.ordinal === nextFragment.blockStart)
    : undefined;
  const generated = await provider.generate({
    sourceSpan,
    ...(options.previousContinuityNote ? { previousContinuityNote: options.previousContinuityNote } : {}),
    boundaryReference: {
      lastAllowedSourceAnchor: sourceSpan.endAnchor,
      ...(nextBlock?.sourceAnchor ? { nextSourceAnchor: nextBlock.sourceAnchor } : {}),
      instruction: "Do not use source material after the last allowed anchor.",
    },
  });
  const rendition = {
    ...generated,
    ...(nextBlock?.text
      ? { nextFragmentBeginsWith: firstWords(nextBlock.text, 12) }
      : {}),
  };
  const validation = validateRendition(sourceSpan, rendition, options);
  return { sourceSpan, rendition, validation };
}

function firstWords(text: string, count: number): string {
  return text.trim().split(/\s+/u).slice(0, count).join(" ");
}
