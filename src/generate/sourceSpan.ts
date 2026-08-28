import type { Edition } from "../core/types.js";
import type { SourceSpan } from "./types.js";

export function buildSourceSpan(edition: Edition, fragmentIndex: number): SourceSpan {
  const fragment = edition.fragments[fragmentIndex];
  if (!fragment) {
    throw new Error(`Fragment ${fragmentIndex} does not exist; edition has ${edition.fragments.length} fragments`);
  }

  const blocks = edition.blocks.filter(
    (block) => block.ordinal >= fragment.blockStart && block.ordinal <= fragment.blockEnd,
  );
  if (blocks.length === 0) {
    throw new Error(`Fragment ${fragmentIndex} has no blocks in range ${fragment.blockStart}–${fragment.blockEnd}`);
  }

  return {
    fragment,
    blocks,
    text: blocks.map((block) => block.text.trim()).filter(Boolean).join(fragment.mode === "verse_verbatim" ? "\n" : "\n\n"),
    mode: fragment.mode,
    startAnchor: blocks[0].sourceAnchor,
    endAnchor: blocks.at(-1)?.sourceAnchor ?? blocks[0].sourceAnchor,
  };
}
