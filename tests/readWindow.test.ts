import { describe, expect, it } from "vitest";
import {
  buildReadStream,
  consumeReadStream,
  fitWordsToLineBox,
  type FragmentBody,
  type WindowPosition,
} from "../src/reader/readWindow.js";

const chapter: FragmentBody = {
  fragmentId: "fragment-0",
  title: "Chapter 1. Loomings.",
  bodyWords: "Call me Ishmael Some years ago having little or no money in my purse".split(" "),
};

const continuation: FragmentBody = {
  fragmentId: "fragment-1",
  bodyWords: "There is now your insular city of the Manhattoes".split(" "),
};

const nextChapter: FragmentBody = {
  fragmentId: "fragment-2",
  title: "Chapter 2. The Carpet-Bag.",
  bodyWords: "I stuffed a shirt or two into my old carpet-bag".split(" "),
};

function pos(partial: Partial<WindowPosition> = {}): WindowPosition {
  return { fragmentIndex: 0, wordOffset: 0, titlePending: false, cardIndex: 0, ...partial };
}

describe("read window", () => {
  it("returns a title card without the chapter prose", () => {
    const stream = buildReadStream([chapter, continuation], pos({ titlePending: true }));
    expect(stream.isTitleCard).toBe(true);
    expect(stream.text).toBe("Chapter 1. Loomings.");
    expect(stream.text).not.toMatch(/Ishmael/u);
  });

  it("fills past a fragment boundary when the next fragment has no title", () => {
    const stream = buildReadStream([chapter, continuation], pos({ wordOffset: chapter.bodyWords.length - 2 }));
    expect(stream.isTitleCard).toBe(false);
    expect(stream.wordsUntilFragmentEnd).toBe(2);
    expect(stream.words.join(" ")).toMatch(/Manhattoes/u);
  });

  it("does not pull the next chapter title into the current window", () => {
    const stream = buildReadStream(
      [chapter, nextChapter],
      pos({ wordOffset: chapter.bodyWords.length - 2 }),
    );
    expect(stream.words.join(" ")).not.toMatch(/Carpet/u);
    expect(stream.wordsUntilFragmentEnd).toBe(2);
  });

  it("consumes a title without moving the body offset", () => {
    const result = consumeReadStream([chapter], pos({ titlePending: true }), 99);
    expect(result.position.titlePending).toBe(false);
    expect(result.position.wordOffset).toBe(0);
    expect(result.fragmentAdvanced).toBe(false);
  });

  it("advances into the next untitled fragment when the window is filled from it", () => {
    const result = consumeReadStream(
      [chapter, continuation],
      pos({ wordOffset: chapter.bodyWords.length - 2 }),
      5,
    );
    expect(result.fragmentAdvanced).toBe(true);
    expect(result.position.fragmentIndex).toBe(1);
    expect(result.position.wordOffset).toBe(3);
    expect(result.completedFragmentIndices).toEqual([0]);
  });

  it("stops at a following chapter title instead of consuming it", () => {
    const result = consumeReadStream(
      [chapter, nextChapter],
      pos({ wordOffset: chapter.bodyWords.length - 1 }),
      8,
    );
    expect(result.fragmentAdvanced).toBe(true);
    expect(result.position.fragmentIndex).toBe(1);
    expect(result.position.titlePending).toBe(true);
    expect(result.position.wordOffset).toBe(0);
  });

  it("fits a line box without splitting words", () => {
    const fitted = fitWordsToLineBox("alpha bravo charlie delta echo foxtrot golf hotel", 12, 2);
    expect(fitted.wordCount).toBeGreaterThan(0);
    expect(fitted.text.split(" ").every((word) => word.length > 0)).toBe(true);
    expect(fitted.text.length).toBeGreaterThan(12);
  });
});
