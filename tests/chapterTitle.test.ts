import { describe, expect, it } from "vitest";
import type { Block, BlockKind } from "../src/core/types.js";
import { extractLeadingChapterTitle, isChapterArgument } from "../src/reader/chapterTitle.js";

function block(ordinal: number, kind: BlockKind, text: string, headingLevel?: number): Block {
  return {
    ordinal,
    spineIndex: 0,
    sourceHref: "ch.xhtml",
    sourceAnchor: `b-${ordinal}`,
    kind,
    text,
    ...(headingLevel === undefined ? {} : { headingLevel }),
  };
}

describe("leading chapter titles", () => {
  it("joins stacked headings for Moby Dick-style chapter openings", () => {
    const title = extractLeadingChapterTitle([
      block(1, "heading", "Chapter 1.", 1),
      block(2, "heading", "Loomings.", 3),
      block(3, "paragraph", "Call me Ishmael. Some years ago—never mind how long precisely—having little or no money."),
    ]);
    expect(title).toBe("Chapter 1. Loomings.");
  });

  it("includes a spaced-dash argument line after the Blood Meridian chapter numeral", () => {
    const title = extractLeadingChapterTitle([
      block(1, "heading", "I", 1),
      block(
        2,
        "paragraph",
        "Childhood in Tennessee – Runs away – New Orleans – Fights – Is shot – To Galveston – Nacogdoches – The Reverend Green – Judge Holden – An affray – Toadvine – Burning of the hotel – Escape.",
      ),
      block(3, "paragraph", "See the child. He is pale and thin."),
    ]);
    expect(title).toMatch(/^I Childhood in Tennessee/u);
    expect(title).toMatch(/Escape\.$/u);
  });

  it("does not treat running prose em-dashes as a chapter argument", () => {
    expect(
      isChapterArgument(
        "Call me Ishmael. Some years ago—never mind how long precisely—having little or no money in my purse.",
      ),
    ).toBe(false);
  });

  it("returns undefined when a fragment does not start with a heading", () => {
    expect(
      extractLeadingChapterTitle([block(1, "paragraph", "See the child. He is pale and thin.")]),
    ).toBeUndefined();
  });
});
