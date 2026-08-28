import type { FragmentRendition, GenerationProvider, GenerationRequest } from "./types.js";

/**
 * A deterministic stand-in for a real editorial model.
 *
 * It exists so the prompt/validation/cache boundary can be exercised without
 * network calls or provider quota. Its prose output is intentionally a draft,
 * not a claim that sentence selection is good editorial compression.
 */
export class LocalDraftProvider implements GenerationProvider {
  readonly id = "local-deterministic-draft-v1";
  readonly promptVersion = "local-draft-v1";

  async generate(request: GenerationRequest): Promise<FragmentRendition> {
    const { sourceSpan } = request;
    if (sourceSpan.mode === "verse_verbatim") {
      return {
        fragmentId: sourceSpan.fragment.id,
        variant: "faithful_fallback",
        providerId: this.id,
        promptVersion: this.promptVersion,
        continuityNote: "",
        fragment: sourceSpan.text,
        sourceCoverage: {
          startAnchor: sourceSpan.startAnchor,
          endAnchor: sourceSpan.endAnchor,
        },
        editorialChanges: ["Verse preserved literally; the local provider does not rewrite verse."],
        finishReason: "STOP",
      };
    }

    const sentences = sourceSpan.blocks
      .filter((block) => !["heading", "furniture", "footnote"].includes(block.kind))
      .flatMap((block) => splitSentences(block.text));
    const selected = selectDraftSentences(sentences, sourceSpan.fragment.sourceWordCount);
    const fragment = selected.join(" ").trim();
    const fallback = fragment.length === 0 || selected.length < 2;

    return {
      fragmentId: sourceSpan.fragment.id,
      variant: fallback ? "faithful_fallback" : "standard",
      providerId: this.id,
      promptVersion: this.promptVersion,
      continuityNote: "",
      fragment: fallback ? sourceSpan.text : fragment,
      sourceCoverage: {
        startAnchor: sourceSpan.startAnchor,
        endAnchor: sourceSpan.endAnchor,
      },
      editorialChanges: fallback
        ? ["Source span preserved because the local draft did not have enough sentence boundaries."]
        : ["Deterministic local draft selected source sentences for pipeline testing; this is not model-quality compression."],
      finishReason: "STOP",
    };
  }
}

function splitSentences(text: string): string[] {
  return (text.match(/[^.!?]+[.!?]+(?:["'”’])?|[^.!?]+$/gu) ?? [])
    .map((sentence) => sentence.replace(/\s+/gu, " ").trim())
    .filter(Boolean);
}

function selectDraftSentences(sentences: string[], sourceWordCount: number): string[] {
  if (sentences.length < 4 || sourceWordCount < 80) return [];

  let stride = 2;
  let selected = selectByStride(sentences, stride);
  let ratio = wordCount(selected.join(" ")) / Math.max(1, sourceWordCount);
  while (ratio > 0.55 && stride < sentences.length) {
    stride += 1;
    selected = selectByStride(sentences, stride);
    ratio = wordCount(selected.join(" ")) / Math.max(1, sourceWordCount);
  }
  if (ratio >= 0.25 && ratio <= 0.55) return selected;

  const expanded = [...selected];
  for (const [index, sentence] of sentences.entries()) {
    if (index % stride === 0) continue;
    expanded.push(sentence);
    if (wordCount(expanded.join(" ")) / sourceWordCount >= 0.25) break;
  }
  const selectedSet = new Set(expanded);
  return sentences.filter((sentence) => selectedSet.has(sentence));
}

function selectByStride(sentences: string[], stride: number): string[] {
  return sentences.filter((_sentence, index) => index % stride === 0);
}

function wordCount(text: string): number {
  return text.trim() === "" ? 0 : text.trim().split(/\s+/u).length;
}
