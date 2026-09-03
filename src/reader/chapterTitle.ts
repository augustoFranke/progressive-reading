import type { Block } from "../core/types.js";
import { flattenCardText } from "./text.js";

/**
 * Leading chapter label for a fragment: consecutive headings, plus an optional
 * McCarthy-style argument line (topics joined by spaced dashes).
 */
export function extractLeadingChapterTitle(blocks: Block[]): string | undefined {
  const parts: string[] = [];
  let index = 0;

  while (index < blocks.length && blocks[index].kind === "heading") {
    const text = blocks[index].text.trim();
    if (text) parts.push(text);
    index += 1;
  }

  if (parts.length === 0) return undefined;

  const next = blocks[index];
  if (next?.kind === "paragraph" && isChapterArgument(next.text)) {
    parts.push(next.text.trim());
  }

  const title = flattenCardText(parts.join(" "));
  return title.length > 0 ? title : undefined;
}

/** "Childhood in Tennessee – Runs away – New Orleans" — not running-prose em dashes. */
export function isChapterArgument(text: string): boolean {
  const spacedDashes = text.match(/\s[–—-]\s/gu) ?? [];
  const words = text.trim().split(/\s+/u).filter((token) => token.length > 0);
  return spacedDashes.length >= 2 && words.length > 0 && words.length <= 80;
}
