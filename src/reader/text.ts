/** Collapse EPUB intra-paragraph hard wraps (single newlines) into spaces. */
export function normalizeCardProse(text: string): string {
  return text.replace(/[ \t]*\n[ \t]*/gu, " ");
}

/** Same flattening the widget uses so measured length matches on-screen wrapping. */
export function flattenCardText(text: string): string {
  return text
    .trim()
    .split(/\s+/u)
    .filter((token) => token.length > 0)
    .join(" ");
}

export function stripLeadingTitle(body: string, title: string): string {
  const bodyWords = flattenCardText(body).split(" ").filter(Boolean);
  const titleWords = flattenCardText(title).split(" ").filter(Boolean);
  if (titleWords.length === 0) return flattenCardText(body);

  // Headings are often omitted from the rendition while an argument line remains.
  // Try the full title first, then shorter suffixes.
  for (let start = 0; start < titleWords.length; start++) {
    const prefix = titleWords.slice(start);
    if (bodyWords.length < prefix.length) continue;
    const matches = prefix.every(
      (word, index) => canonicalizeWord(bodyWords[index]) === canonicalizeWord(word),
    );
    if (matches) return bodyWords.slice(prefix.length).join(" ");
  }

  return flattenCardText(body);
}

function canonicalizeWord(word: string | undefined): string {
  return (word ?? "")
    .replace(/[–—]/gu, "-")
    .replace(/[^\p{L}\p{N}-]/gu, "")
    .toLowerCase();
}
