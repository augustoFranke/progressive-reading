import type { FragmentRendition, SourceSpan, ValidationCheck, ValidationCheckStatus, ValidationContext, ValidationReport } from "./types.js";

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
    const literalStatus: ValidationCheckStatus =
      literal.longestSequence <= 40 && literal.ratio <= 0.55
        ? "pass"
        : literal.longestSequence <= 50 && literal.ratio <= 0.7
          ? "warn"
          : "fail";
    addCheck(checks, "V5", "literal quotation", literalStatus,
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
  const concreteStatus: ValidationCheckStatus =
    concrete.required === 0 || concrete.ratio >= 0.6
      ? "pass"
      : concrete.ratio >= 0.45
        ? "warn"
        : "fail";
  addCheck(checks, "V6", "concrete detail retention", concreteStatus,
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
      if (length >= 4) {
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

const NUMBER_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100, thousand: 1000, million: 1000000,
};

const COMMON_SENTENCE_STARTERS = new Set([
  "The", "This", "That", "These", "Those", "There", "What", "When", "Where", "Which",
  "Who", "Whose", "Why", "How", "After", "Before", "Again", "Only", "He", "She", "They",
  "We", "You", "His", "Her", "Their", "Our", "Its", "All", "Some", "Many", "Few", "One",
  "Two", "Three", "Four", "Five", "First", "Second", "Third", "Then", "Thus", "So", "And",
  "But", "Or", "If", "While", "As", "In", "At", "On", "By", "For", "From", "With", "Into",
  "Through", "During", "Just", "Soon", "Now", "Here", "Out", "Up", "Down", "Over", "Under",
  "About", "Like", "Such", "No", "Not", "Never", "Every", "Each", "Both", "Neither", "Either",
  "Well", "Yes", "See", "Look", "Listen", "Say", "Said", "Dont", "Doesnt", "Wont", "Cant",
  "Couldnt", "Wouldnt", "Shouldnt", "Aint", "Isnt", "Arent", "Wasnt", "Werent",
]);

export interface ExtractedEntities {
  names: string[];
  numbers: string[];
  normalizedTokens: Set<string>;
}

function parseSpelledNumber(phrase: string): number | undefined {
  const parts = phrase.toLowerCase().replace(/-/gu, " ").split(/\s+/u).filter((w) => w !== "and");
  if (parts.length === 0) return undefined;

  const firstVal = NUMBER_WORDS[parts[0]];
  if (firstVal !== undefined && firstVal >= 11 && firstVal <= 29 && parts.length >= 2) {
    let rest = 0;
    let validRest = true;
    for (let i = 1; i < parts.length; i++) {
      const v = NUMBER_WORDS[parts[i]];
      if (v === undefined || v >= 100) {
        validRest = false;
        break;
      }
      rest += v;
    }
    if (validRest && rest >= 1 && rest <= 99) {
      return firstVal * 100 + rest;
    }
  }

  let total = 0;
  let current = 0;
  let valid = false;

  for (const word of parts) {
    const val = NUMBER_WORDS[word];
    if (val === undefined) return undefined;
    valid = true;
    if (val === 100) {
      current = current === 0 ? 100 : current * 100;
    } else if (val === 1000 || val === 1000000) {
      current = current === 0 ? val : current * val;
      total += current;
      current = 0;
    } else {
      current += val;
    }
  }
  if (!valid) return undefined;
  total += current;
  return total;
}

export function extractEntities(text: string): ExtractedEntities {
  const normalizedText = normalizeWhitespace(text);
  const names = new Set<string>();
  const numbers = new Set<string>();
  const normalizedTokens = new Set<string>();

  const digitMatches = normalizedText.match(/\b\d+(?:[.,]\d+)?\b/gu) ?? [];
  for (const digit of digitMatches) {
    numbers.add(digit);
    normalizedTokens.add(digit);
  }

  const numberPhraseRegex = /\b(?:(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million)(?:[\s-]+(?:and\s+)?(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million))*)\b/giu;
  const spelledMatches = normalizedText.match(numberPhraseRegex) ?? [];
  for (const phrase of spelledMatches) {
    const trimmed = phrase.trim().toLowerCase();
    if (!trimmed) continue;
    const parsed = parseSpelledNumber(trimmed);
    if (parsed !== undefined) {
      numbers.add(trimmed);
      normalizedTokens.add(trimmed);
      normalizedTokens.add(trimmed.toLowerCase());
      normalizedTokens.add(trimmed.replace(/[\s-]+/gu, ""));
      normalizedTokens.add(String(parsed));
    }
  }

  const multiWordRegex = /\b[A-Z][\p{L}'’-]+(?:\s+[A-Z][\p{L}'’-]+)+\b/gu;
  const multiWordMatches = normalizedText.match(multiWordRegex) ?? [];
  for (const match of multiWordMatches) {
    const words = match.split(/\s+/u);
    if (words.every((w) => COMMON_SENTENCE_STARTERS.has(w))) continue;
    names.add(match);
    normalizedTokens.add(match.toLowerCase());
    normalizedTokens.add(match.toLowerCase().replace(/[\s-]+/gu, ""));
    for (const word of words) {
      if (!COMMON_SENTENCE_STARTERS.has(word) && word.length > 2) {
        names.add(word);
        normalizedTokens.add(word.toLowerCase());
      }
    }
  }

  const sentences = normalizedText.split(/(?<=[.!?]["'”’]?)\s+/u);
  for (const sentence of sentences) {
    const words = sentence.split(/\s+/u);
    for (let i = 1; i < words.length; i++) {
      const rawWord = words[i].replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
      if (!rawWord || rawWord.length < 3) continue;
      if (/^[A-Z][\p{L}'’-]+$/u.test(rawWord) && !COMMON_SENTENCE_STARTERS.has(rawWord)) {
        names.add(rawWord);
        normalizedTokens.add(rawWord.toLowerCase());
      }
    }
  }

  return {
    names: [...names],
    numbers: [...numbers],
    normalizedTokens,
  };
}

function concreteRetention(
  source: string,
  rendition: string,
  previousContinuityNote?: string,
): { required: number; retained: number; ratio: number; unsupported: string[] } {
  const sourceEntities = extractEntities(source);
  const renditionEntities = extractEntities(rendition);
  const allowedContextEntities = extractEntities(previousContinuityNote ?? "");

  const sourceNormalized = sourceEntities.normalizedTokens;
  const renditionNormalized = renditionEntities.normalizedTokens;
  const allowedContextNormalized = allowedContextEntities.normalizedTokens;

  const requiredEntities = new Set([
    ...sourceEntities.names.map((n) => n.toLowerCase()),
    ...sourceEntities.numbers.map((n) => n.toLowerCase()),
  ]);

  let retained = 0;
  for (const entity of requiredEntities) {
    const compact = entity.replace(/[\s-]+/gu, "");
    if (
      renditionNormalized.has(entity) ||
      renditionNormalized.has(compact) ||
      [...renditionNormalized].some((t) => t.includes(entity) || entity.includes(t))
    ) {
      retained += 1;
    }
  }

  const unsupported: string[] = [];
  for (const name of renditionEntities.names) {
    const lower = name.toLowerCase();
    const compact = lower.replace(/[\s-]+/gu, "");
    if (
      !sourceNormalized.has(lower) &&
      !sourceNormalized.has(compact) &&
      !allowedContextNormalized.has(lower) &&
      !allowedContextNormalized.has(compact) &&
      ![...sourceNormalized].some((s) => s.includes(lower) || lower.includes(s))
    ) {
      unsupported.push(name);
    }
  }
  for (const num of renditionEntities.numbers) {
    const lower = num.toLowerCase();
    const compact = lower.replace(/[\s-]+/gu, "");
    const parsed = parseSpelledNumber(num);
    const parsedStr = parsed !== undefined ? String(parsed) : undefined;
    if (
      !sourceNormalized.has(lower) &&
      !sourceNormalized.has(compact) &&
      (parsedStr === undefined || !sourceNormalized.has(parsedStr)) &&
      !allowedContextNormalized.has(lower) &&
      !allowedContextNormalized.has(compact) &&
      (parsedStr === undefined || !allowedContextNormalized.has(parsedStr))
    ) {
      unsupported.push(num);
    }
  }

  const uniqueUnsupported = [...new Set(unsupported)];
  const requiredCount = requiredEntities.size;
  const ratio = requiredCount === 0 ? 1 : retained / requiredCount;

  return {
    required: requiredCount,
    retained,
    ratio,
    unsupported: uniqueUnsupported,
  };
}
