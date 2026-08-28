import type { FragmentRendition, SourceSpan, ValidationCheck, ValidationContext, ValidationReport } from "./types.js";

const BANNED_FRAMING = /\b(the author says|the author argues|in summary|to summarize|the lesson is|the point is|o autor diz|em resumo|a lição é)\b/iu;

export function validateRendition(
  sourceSpan: SourceSpan,
  rendition: FragmentRendition,
  context: ValidationContext = {},
): ValidationReport {
  const checks: ValidationCheck[] = [];
  const sourceWordCount = wordCount(sourceSpan.text);
  const renditionWordCount = wordCount(rendition.fragment);
  const compressionRatio = renditionWordCount / Math.max(1, sourceWordCount);

  addCheck(checks, "V1", "structured response", rendition.fragment.trim().length > 0 &&
    rendition.fragmentId === sourceSpan.fragment.id &&
    rendition.sourceCoverage.startAnchor.length > 0 &&
    rendition.sourceCoverage.endAnchor.length > 0
    ? "pass" : "fail", "Required rendition fields are present.");

  const anchorsMatch = rendition.sourceCoverage.startAnchor === sourceSpan.startAnchor &&
    rendition.sourceCoverage.endAnchor === sourceSpan.endAnchor;
  addCheck(checks, "V2", "source coverage", anchorsMatch ? "pass" : "fail",
    anchorsMatch
      ? "Rendition covers the planned source span anchors."
      : "Rendition anchors do not match the planned source span.");

  const finishValid = rendition.finishReason !== "SAFETY" &&
    rendition.finishReason !== "RECITATION" && rendition.finishReason !== "ERROR";
  addCheck(checks, "V9", "provider finish reason", finishValid ? "pass" : "fail",
    finishValid ? "Provider finished without a blocked or failed reason." : `Provider finished with ${rendition.finishReason}.`);

  if (sourceSpan.mode === "verse_verbatim") {
    const exact = normalizeWhitespace(rendition.fragment) === normalizeWhitespace(sourceSpan.text);
    addCheck(checks, "VERSE", "literal verse identity", exact ? "pass" : "fail",
      exact ? "Verse matches the source after whitespace normalization." : "Verse was changed by the rendition.");
    return summarize(checks, sourceWordCount, renditionWordCount, undefined);
  }

  if (rendition.variant === "faithful_fallback") {
    addCheck(checks, "V4/V5", "compression and quotation", "warn",
      "Compression and quotation limits are not applied to a faithful fallback.");
  } else {
    const compressionPass = compressionRatio >= 0.25 && compressionRatio <= 0.55;
    addCheck(checks, "V4", "compression ratio", compressionPass ? "pass" : "fail",
      `Rendition/source ratio is ${compressionRatio.toFixed(2)}; expected 0.25–0.55.`);

    const literal = literalOverlap(sourceSpan.text, rendition.fragment);
    const literalPass = literal.longestSequence <= 40 && literal.ratio <= 0.25;
    addCheck(checks, "V5", "literal quotation", literalPass ? "pass" : "fail",
      `Longest literal sequence is ${literal.longestSequence} words and copied-word ratio is ${literal.ratio.toFixed(2)}.`);
  }

  const concrete = concreteRetention(
    sourceSpan.text,
    rendition.fragment,
    context.previousContinuityNote,
  );
  const unsupported = concrete.unsupported;
  addCheck(checks, "V3", "unsupported concrete details", unsupported.length === 0 ? "pass" : "fail",
    unsupported.length === 0
      ? "No new detected names or numbers were found outside the source span or prior continuity note."
      : `Detected unsupported names or numbers: ${unsupported.join(", ")}.`);
  const concretePass = concrete.required === 0 || concrete.ratio >= 0.7;
  addCheck(checks, "V6", "concrete detail retention", concretePass ? "pass" : "fail",
    concrete.required === 0
      ? "No names or numbers were detected for this check."
      : `Retained ${concrete.retained}/${concrete.required} detected names or numbers (${concrete.ratio.toFixed(2)}).`);

  const framingPass = !BANNED_FRAMING.test(rendition.fragment);
  addCheck(checks, "V7", "editorial framing", framingPass ? "pass" : "fail",
    framingPass ? "No banned summary framing was detected." : "The rendition uses banned summary framing.");

  const lengthPass = renditionWordCount > 0 && compressionRatio >= 0.2 && compressionRatio <= 0.65;
  addCheck(checks, "V8", "target length", lengthPass ? "pass" : "warn",
    `Rendition/source ratio is ${compressionRatio.toFixed(2)} for the requested reading band.`);

  return summarize(checks, sourceWordCount, renditionWordCount, compressionRatio);
}

function summarize(
  checks: ValidationCheck[],
  sourceWordCount: number,
  renditionWordCount: number,
  compressionRatio: number | undefined,
): ValidationReport {
  const status = checks.some((check) => check.status === "fail")
    ? "fail"
    : checks.some((check) => check.status === "warn")
      ? "review"
      : "pass";
  return { status, checks, sourceWordCount, renditionWordCount, ...(compressionRatio === undefined ? {} : { compressionRatio }) };
}

function addCheck(
  checks: ValidationCheck[],
  id: string,
  label: string,
  status: ValidationCheck["status"],
  message: string,
): void {
  checks.push({ id, label, status, message });
}

function wordCount(text: string): number {
  return text.trim() === "" ? 0 : text.trim().split(/\s+/u).length;
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

function tokenize(text: string): string[] {
  return normalizeWhitespace(text).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function literalOverlap(source: string, rendition: string): { longestSequence: number; ratio: number } {
  const sourceWords = tokenize(source);
  const renditionWords = tokenize(rendition);
  const sourcePositions = new Map<string, number[]>();
  for (const [index, word] of sourceWords.entries()) {
    const positions = sourcePositions.get(word) ?? [];
    positions.push(index);
    sourcePositions.set(word, positions);
  }
  let longestSequence = 0;
  const literalCoverage = new Set<number>();

  for (const [renditionIndex, word] of renditionWords.entries()) {
    for (const sourceIndex of sourcePositions.get(word) ?? []) {
      let length = 0;
      while (
        renditionWords[renditionIndex + length] !== undefined &&
        sourceWords[sourceIndex + length] === renditionWords[renditionIndex + length]
      ) {
        length += 1;
      }
      longestSequence = Math.max(longestSequence, length);
      if (length >= 2) {
        for (let offset = 0; offset < length; offset += 1) {
          literalCoverage.add(renditionIndex + offset);
        }
      }
    }
  }

  return {
    longestSequence,
    ratio: literalCoverage.size / Math.max(1, renditionWords.length),
  };
}

function concreteRetention(
  source: string,
  rendition: string,
  previousContinuityNote?: string,
): { required: number; retained: number; ratio: number; unsupported: string[] } {
  const sourceTokens = new Set(extractConcreteTokens(source));
  const renditionTokens = new Set(extractConcreteTokens(rendition));
  const allowedContextTokens = new Set(extractConcreteTokens(previousContinuityNote ?? ""));
  const retained = [...sourceTokens].filter((token) => renditionTokens.has(token)).length;
  const unsupported = [...renditionTokens]
    .filter((token) => !sourceTokens.has(token) && !allowedContextTokens.has(token));
  return {
    required: sourceTokens.size,
    retained,
    ratio: retained / Math.max(1, sourceTokens.size),
    unsupported,
  };
}

function extractConcreteTokens(text: string): string[] {
  const numbers = text.match(/\b\d+(?:[.,]\d+)?\b/gu) ?? [];
  const names = text.match(/\b[A-Z][\p{L}'’-]{2,}\b/gu) ?? [];
  const ignored = new Set(["The", "This", "That", "These", "Those", "There", "What", "When", "Where", "Which", "After", "Before", "Again", "Only"]);
  return [...new Set([...numbers, ...names.filter((name) => !ignored.has(name))])];
}
