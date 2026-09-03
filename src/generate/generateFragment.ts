import type { Edition } from "../core/types.js";
import { LocalDraftProvider } from "./localProvider.js";
import { buildSourceSpan, computeOutputTarget } from "./sourceSpan.js";
import type {
  GeneratedFragment,
  GenerationProvider,
  QualityJudge,
  QualityJudgeReport,
  ValidationContext,
} from "./types.js";
import { validateRendition } from "./validators.js";

export interface GenerateFragmentOptions extends ValidationContext {
  judge?: QualityJudge;
}

export async function generateFragment(
  edition: Edition,
  fragmentIndex: number,
  provider: GenerationProvider = new LocalDraftProvider(),
  options: GenerateFragmentOptions = {},
): Promise<GeneratedFragment> {
  const sourceSpan = buildSourceSpan(edition, fragmentIndex);
  const outputTarget = computeOutputTarget(sourceSpan.fragment.sourceWordCount);
  const nextFragment = edition.fragments[fragmentIndex + 1];
  const nextBlock = nextFragment
    ? edition.blocks.find((block) => block.ordinal === nextFragment.blockStart)
    : undefined;

  const baseRequest = {
    sourceSpan,
    outputTarget,
    ...(options.previousContinuityNote ? { previousContinuityNote: options.previousContinuityNote } : {}),
    boundaryReference: {
      lastAllowedSourceAnchor: sourceSpan.endAnchor,
      ...(nextBlock?.sourceAnchor ? { nextSourceAnchor: nextBlock.sourceAnchor } : {}),
      instruction: "Do not use source material after the last allowed anchor." as const,
    },
  };

  const initialGenerated = await provider.generate(baseRequest);
  let rendition = {
    ...initialGenerated,
    ...(nextBlock?.text
      ? { nextFragmentBeginsWith: firstWords(nextBlock.text, 12) }
      : {}),
  };
  let validation = validateRendition(sourceSpan, rendition, options);
  let judgeReport: QualityJudgeReport | undefined;

  if (options.judge && validation.status !== "fail" && rendition.variant !== "faithful_fallback") {
    try {
      judgeReport = await options.judge.evaluate(sourceSpan, rendition, options);
    } catch {
      // Judge evaluation error should not crash generation
    }
  }

  // Single targeted repair attempt if initial generation failed deterministic validation or quality judge
  const needsRepair =
    (validation.status === "fail" || judgeReport?.status === "fail") &&
    rendition.variant !== "faithful_fallback";

  if (needsRepair) {
    const failedChecks = validation.checks.filter((check) => check.status === "fail");
    const judgeCritique = judgeReport?.critique;
    try {
      const repairedGenerated = await provider.generate({
        ...baseRequest,
        repairContext: {
          previousRendition: rendition.fragment,
          failedChecks,
          ...(judgeCritique && judgeCritique.length > 0 ? { judgeCritique } : {}),
        },
      });
      const repairedRendition = {
        ...repairedGenerated,
        ...(nextBlock?.text
          ? { nextFragmentBeginsWith: firstWords(nextBlock.text, 12) }
          : {}),
      };
      const repairedValidation = validateRendition(sourceSpan, repairedRendition, options);
      let repairedJudgeReport: QualityJudgeReport | undefined;

      if (options.judge && repairedValidation.status !== "fail") {
        try {
          repairedJudgeReport = await options.judge.evaluate(sourceSpan, repairedRendition, options);
        } catch {
          // ignore judge error on repair
        }
      }

      const repairPassed =
        repairedValidation.status !== "fail" &&
        (!repairedJudgeReport || repairedJudgeReport.status !== "fail");

      if (repairPassed) {
        rendition = repairedRendition;
        validation = repairedValidation;
        judgeReport = repairedJudgeReport;
      }
    } catch {
      // Repair request threw an exception; fall through to graceful fallback
    }
  }

  // Graceful faithful fallback if generation still fails validation or judge
  const stillFailing =
    (validation.status === "fail" || judgeReport?.status === "fail") &&
    rendition.variant !== "faithful_fallback";

  if (stillFailing) {
    rendition = {
      fragmentId: sourceSpan.fragment.id,
      variant: "faithful_fallback",
      providerId: rendition.providerId,
      promptVersion: rendition.promptVersion,
      continuityNote: rendition.continuityNote || "",
      fragment: sourceSpan.text,
      sourceCoverage: {
        startAnchor: sourceSpan.startAnchor,
        endAnchor: sourceSpan.endAnchor,
      },
      editorialChanges: [
        "Validation failed after repair attempt; served faithful fallback.",
        ...validation.checks.filter((check) => check.status === "fail").map((check) => `[${check.id}] ${check.message}`),
        ...(judgeReport?.critique.map((c) => `[Judge] ${c}`) ?? []),
      ],
      ...(nextBlock?.text
        ? { nextFragmentBeginsWith: firstWords(nextBlock.text, 12) }
        : {}),
      finishReason: rendition.finishReason ?? "STOP",
    };
    validation = validateRendition(sourceSpan, rendition, options);
    if (options.judge) {
      try {
        judgeReport = await options.judge.evaluate(sourceSpan, rendition, options);
      } catch {
        // ignore
      }
    }
  }

  return { sourceSpan, rendition, validation, ...(judgeReport ? { judgeReport } : {}) };
}

function firstWords(text: string, count: number): string {
  return text.trim().split(/\s+/u).slice(0, count).join(" ");
}
