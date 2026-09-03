import { describe, expect, it } from "vitest";
import { flattenCardText, normalizeCardProse, splitFragmentIntoCards } from "../src/reader/cardPaging.js";

const BLOOD_MERIDIAN_SAMPLE = `See the child. He is pale and thin, he stokes the scullery fire in Tennessee. Outside lie dark turned fields and woods that harbor yet a few last wolves. His father lies in drink, quoting from poets whose names are now lost. The boy crouches by the fire and watches him, unable to read or write, harboring already a taste for mindless violence.

At fourteen he runs away, wandering west as far as Memphis upon that flat landscape where blacks toil in the cotton fields. A year later he is in Saint Louis, taking passage for New Orleans aboard a flatboat—forty-two days on the river waters. In New Orleans he lives in a room behind a tavern and comes down at night to fight sailors in the mud. On a certain night a Maltese boatswain shoots him in the back with a pistol; swinging to deal with the man, he is shot again below the heart. He lies in an upstairs cot for two weeks while the tavernkeeper’s wife attends his slops. Once mended, having no money, he flees to the riverbank and finds a boat bound for Texas.

Divested of all he has been, the child watches the dim shore rise and fall, seabirds and flights of pelicans above the gray swells. The settlers disembark aboard a lighter into the coastal haze. He walks the port streets smelling of salt and lumber, then moves north alone through small farms and settlements, working day wages. In a crossroads hamlet he sees a parricide hanged dead from his rope. He labors in a sawmill and a diphtheria pesthouse, taking as pay an aged mule.

Aback this animal in the spring of the year eighteen and forty-nine he rides through the republic of Fredonia into the town of Nacogdoches. Rain has fallen for two weeks. He ducks into a canvas tent where the Reverend Green preaches hellfire to an unwashed crowd. A teamster with long moustaches watches him earnestly. You ever see such a place for rain? I just got here, said the kid. Well it beats all I ever seen.

Suddenly an enormous man dressed in an oilcloth slicker enters: bald as a stone, without beard or brows or lashes, standing close on to seven feet in height, smoking a cigar. The reverend falls silent as the stranger pushes forward to the crateboard pulpit and turns to address the congregation.`;

describe("Widget Card Paging Engine", () => {
  it("fills cards to a character budget and leaves the remainder on the last card", () => {
    const maxCharactersPerCard = 220;
    const cards = splitFragmentIntoCards(BLOOD_MERIDIAN_SAMPLE, "fragment-0", {
      maxCharactersPerCard,
    });

    expect(cards.length).toBeGreaterThan(1);
    for (let i = 0; i < cards.length; i++) {
      const card = cards[i];
      expect(card.cardIndex).toBe(i);
      expect(card.totalCards).toBe(cards.length);
      expect(card.fragmentId).toBe("fragment-0");
      expect(card.text.trim().length).toBeGreaterThan(0);
      expect(card.isFinalCardOfFragment).toBe(i === cards.length - 1);
      if (i < cards.length - 1) {
        expect(card.text.length).toBeLessThanOrEqual(maxCharactersPerCard);
        expect(card.text.length).toBeGreaterThan(maxCharactersPerCard * 0.5);
      } else {
        expect(card.text.length).toBeLessThanOrEqual(maxCharactersPerCard);
      }
    }

    const combinedOriginalWords = flattenCardText(BLOOD_MERIDIAN_SAMPLE).split(" ").length;
    const combinedCardWords = cards.reduce((sum, c) => sum + c.wordCount, 0);
    expect(combinedCardWords).toBe(combinedOriginalWords);
    expect(cards.map((c) => c.text).join(" ")).toBe(flattenCardText(BLOOD_MERIDIAN_SAMPLE));
  });

  it("handles short fragment without unnecessary splitting", () => {
    const shortText = "The kid leaves Tennessee. He travels downriver and reaches the port of Galveston.";
    const cards = splitFragmentIntoCards(shortText, "fragment-short");

    expect(cards.length).toBe(1);
    expect(cards[0].cardIndex).toBe(0);
    expect(cards[0].totalCards).toBe(1);
    expect(cards[0].isFinalCardOfFragment).toBe(true);
    expect(cards[0].text).toBe(shortText);
  });

  it("uses the 4x2 widget character default so cards do not exceed 290 characters", () => {
    const sentence = "The riders crossed the alkali flats under a pale sun. ";
    const fragmentText = sentence.repeat(16).trim();

    const cards = splitFragmentIntoCards(fragmentText, "fragment-defaults");

    expect(cards.length).toBeGreaterThan(2);
    for (const card of cards) {
      expect(card.text.length).toBeLessThanOrEqual(290);
    }

    const combinedOriginalWords = flattenCardText(fragmentText).split(" ").length;
    const combinedCardWords = cards.reduce((sum, c) => sum + c.wordCount, 0);
    expect(combinedCardWords).toBe(combinedOriginalWords);
  });

  it("collapses intra-paragraph EPUB wrap newlines in emitted card text", () => {
    const fragmentText =
      "Call me Ishmael. Some years ago—never mind how long precisely—having little or no money in my purse, and nothing particular to interest me on shore, I thought I would sail about a little and see the watery part of the world. It is a way I have of driving off the spleen and regulating the circulation. Whenever I find myself growing grim about the mouth; whenever it is a damp, drizzly November in my soul; whenever I find myself involuntarily pausing before coffin warehouses, and bringing up the rear of every funeral I meet; and especially whenever my hypos get such an upper hand of me, that it requires a strong moral principle to prevent me from deliberately stepping into the street, and methodically knocking people's hats off—then, I account it high time to get to sea as soon as I can.";

    const wrapped = fragmentText.replace(/about the mouth;/u, "about\nthe mouth;");

    const cards = splitFragmentIntoCards(wrapped, "fragment-wrap");

    expect(cards.length).toBeGreaterThanOrEqual(1);
    for (const card of cards) {
      expect(card.text).not.toMatch(/\n/u);
    }
    expect(cards.some((c) => c.text.includes("about the mouth;"))).toBe(true);

    const combinedOriginalWords = flattenCardText(normalizeCardProse(wrapped)).split(" ").length;
    const combinedCardWords = cards.reduce((sum, c) => sum + c.wordCount, 0);
    expect(combinedCardWords).toBe(combinedOriginalWords);
  });

  it("does not split in the middle of a word", () => {
    const text = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa";
    const cards = splitFragmentIntoCards(text, "fragment-words", { maxCharactersPerCard: 30 });

    expect(cards.length).toBeGreaterThan(1);
    for (const card of cards) {
      expect(card.text.length).toBeLessThanOrEqual(30);
      expect(card.text.startsWith(" ")).toBe(false);
      expect(card.text.endsWith(" ")).toBe(false);
      for (const token of card.text.split(" ")) {
        expect(text.split(" ")).toContain(token);
      }
    }
    expect(cards.map((c) => c.text).join(" ")).toBe(text);
  });

  it("honors a larger character budget override", () => {
    const sentence = "The riders crossed the alkali flats under a pale sun that cast no shadow. ";
    const longSingleParagraph = sentence.repeat(15).trim();

    const cards = splitFragmentIntoCards(longSingleParagraph, "fragment-long", {
      maxCharactersPerCard: 450,
    });

    expect(cards.length).toBeGreaterThan(1);
    for (let i = 0; i < cards.length - 1; i++) {
      expect(cards[i].text.length).toBeLessThanOrEqual(450);
    }
  });

  it("puts a chapter title on its own first card and does not repeat it in the body", () => {
    const title = "Chapter 1. Loomings.";
    const body =
      "Call me Ishmael. Some years ago having little or no money in my purse I thought I would sail about a little and see the watery part of the world. ".repeat(
        4,
      );
    const cards = splitFragmentIntoCards(`${title} ${body}`, "fragment-0", {
      leadingTitle: title,
      maxCharactersPerCard: 220,
    });

    expect(cards[0].text).toBe(title);
    expect(cards[0].isFinalCardOfFragment).toBe(false);
    expect(cards.length).toBeGreaterThan(1);
    const rest = cards
      .slice(1)
      .map((c) => c.text)
      .join(" ");
    expect(rest.startsWith("Call me Ishmael")).toBe(true);
    expect(rest).not.toMatch(/^Chapter 1/u);
  });

  it("strips a heading-less argument prefix left in the rendition", () => {
    const title =
      "I Childhood in Tennessee – Runs away – New Orleans – Fights – Is shot – To Galveston – Nacogdoches – The Reverend Green – Judge Holden – An affray – Toadvine – Burning of the hotel – Escape.";
    const argument =
      "Childhood in Tennessee – Runs away – New Orleans – Fights – Is shot – To Galveston – Nacogdoches – The Reverend Green – Judge Holden – An affray – Toadvine – Burning of the hotel – Escape.";
    const cards = splitFragmentIntoCards(`${argument} See the child. He is pale and thin.`, "fragment-0", {
      leadingTitle: title,
    });

    expect(cards[0].text).toBe(flattenCardText(title));
    expect(cards[1].text).toMatch(/^See the child/u);
    expect(cards.map((c) => c.text).join(" ")).not.toMatch(/Escape\. Escape/u);
  });

  it("does not character-split a long title card", () => {
    const title = `I ${"topic – ".repeat(40)}Escape.`;
    const cards = splitFragmentIntoCards("See the child. He is pale and thin.", "fragment-0", {
      leadingTitle: title,
      maxCharactersPerCard: 80,
    });

    expect(cards[0].text).toBe(flattenCardText(title));
    expect(cards[0].text.length).toBeGreaterThan(80);
    expect(cards[1].text).toMatch(/^See the child/u);
  });
});
