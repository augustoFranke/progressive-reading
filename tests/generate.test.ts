import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ingestUpload } from "../src/pipeline/ingestUpload.js";
import { GeminiProvider } from "../src/generate/geminiProvider.js";
import { generateFragment } from "../src/generate/generateFragment.js";
import { buildSourceSpan, computeOutputTarget } from "../src/generate/sourceSpan.js";
import type { GenerationRequest } from "../src/generate/types.js";
import type { GenerateContentResponse } from "@google/genai";
import { validateRendition } from "../src/generate/validators.js";

const root = resolve(import.meta.dirname, "..");

describe("editorial generation slice", () => {
  it("builds a bounded prose request and validates its exact source anchors", async () => {
    const edition = await ingestUpload(resolve(root, "blood meridian.epub"));
    const result = await generateFragment(edition, 0);

    expect(result.sourceSpan.blocks[0].ordinal).toBe(edition.fragments[0].blockStart);
    expect(result.sourceSpan.blocks.at(-1)?.ordinal).toBe(edition.fragments[0].blockEnd);
    expect(result.rendition.fragmentId).toBe(edition.fragments[0].id);
    expect(result.rendition.sourceCoverage.startAnchor).toBe(result.sourceSpan.startAnchor);
    expect(result.rendition.sourceCoverage.endAnchor).toBe(result.sourceSpan.endAnchor);
    expect(result.validation.checks.find((check) => check.id === "V2")?.status).toBe("pass");
    expect(result.rendition.providerId).toBe("local-deterministic-draft-v1");
  });

  it("preserves a verse fragment literally in the local branch", async () => {
    const edition = await ingestUpload(resolve(root, "paradise lost.epub"));
    const fragmentIndex = edition.fragments.findIndex((fragment) => fragment.mode === "verse_verbatim");
    expect(fragmentIndex).toBeGreaterThanOrEqual(0);

    const result = await generateFragment(edition, fragmentIndex);
    expect(result.rendition.variant).toBe("faithful_fallback");
    expect(normalizeWhitespace(result.rendition.fragment)).toBe(normalizeWhitespace(result.sourceSpan.text));
    expect(result.validation.status).toBe("pass");
    expect(result.validation.checks.find((check) => check.id === "VERSE")?.status).toBe("pass");
  });

  it("fails a rendition that changes coverage or uses banned summary framing", async () => {
    const edition = await ingestUpload(resolve(root, "blood meridian.epub"));
    const result = await generateFragment(edition, 0);
    const invalid = {
      ...result.rendition,
      fragment: "In summary, the author says the point is that everything changes.",
      sourceCoverage: {
        startAnchor: "wrong-start",
        endAnchor: result.sourceSpan.endAnchor,
      },
    };
    const validation = validateRendition(result.sourceSpan, invalid);
    expect(validation.status).toBe("fail");
    expect(validation.checks.find((check) => check.id === "V2")?.status).toBe("fail");
    expect(validation.checks.find((check) => check.id === "V7")?.status).toBe("fail");
  });

  it("passes only the current span plus an explicit boundary contract to providers", async () => {
    const edition = await ingestUpload(resolve(root, "blood meridian.epub"));
    let captured: GenerationRequest | undefined;
    const provider = {
      id: "test-provider",
      promptVersion: "test-v1",
      async generate(request: GenerationRequest) {
        captured = request;
        return {
          fragmentId: request.sourceSpan.fragment.id,
          variant: "faithful_fallback" as const,
          providerId: "test-provider",
          promptVersion: "test-v1",
          continuityNote: "",
          fragment: request.sourceSpan.text,
          sourceCoverage: {
            startAnchor: request.sourceSpan.startAnchor,
            endAnchor: request.sourceSpan.endAnchor,
          },
          editorialChanges: [],
          finishReason: "STOP" as const,
        };
      },
    };

    await generateFragment(edition, 0, provider, { previousContinuityNote: "Earlier continuity." });
    expect(captured?.previousContinuityNote).toBe("Earlier continuity.");
    expect(captured?.boundaryReference.instruction).toContain("Do not use source material");
    expect(captured?.sourceSpan).not.toHaveProperty("edition");
  });

  it("sends only the bounded prose span to Gemini and maps its structured response", async () => {
    const edition = await ingestUpload(resolve(root, "blood meridian.epub"));
    const sourceSpan = buildSourceSpan(edition, 0);
    let requestContents = "";
    let responseMimeType: string | undefined;
    let responseSchema: unknown;
    const mockText = "A rider crosses the plain into the darkening hills.";
    const provider = new GeminiProvider({
      apiKey: "test-key",
      model: "test-model",
      client: {
        models: {
          async generateContent(parameters) {
            requestContents = String(parameters.contents);
            responseMimeType = parameters.config?.responseMimeType;
            responseSchema = parameters.config?.responseJsonSchema;
            return {
              text: JSON.stringify({
                continuityNote: "A rider enters the next stretch.",
                fragment: mockText,
                sourceCoverage: {
                  startAnchor: sourceSpan.startAnchor,
                  endAnchor: sourceSpan.endAnchor,
                },
                editorialChanges: ["Compressed the current span."],
              }),
              candidates: [{ finishReason: "STOP" }],
            } as unknown as GenerateContentResponse;
          },
        },
      },
    });

    const outputTarget = computeOutputTarget(sourceSpan.fragment.sourceWordCount);
    const rendition = await provider.generate({
      sourceSpan,
      outputTarget,
      previousContinuityNote: "Earlier continuity.",
      boundaryReference: {
        lastAllowedSourceAnchor: sourceSpan.endAnchor,
        instruction: "Do not use source material after the last allowed anchor.",
      },
    });

    expect(requestContents).toContain("SOURCE SPAN BEGIN");
    expect(requestContents).toContain("Do not use source material after the last allowed anchor.");
    expect(requestContents).toContain(sourceSpan.startAnchor);
    expect(requestContents).toContain(sourceSpan.endAnchor);
    expect(requestContents).toContain(`SOURCE_WORD_COUNT: ${sourceSpan.fragment.sourceWordCount}`);
    expect(requestContents).toContain("MIN_OUTPUT_WORDS: ");
    expect(requestContents).toContain("TARGET_OUTPUT_WORDS: ");
    expect(requestContents).toContain("MAX_OUTPUT_WORDS: ");
    expect(requestContents).toContain(`TARGET_READ_SECONDS: ${sourceSpan.fragment.targetReadSeconds}`);
    expect(requestContents).toContain(sourceSpan.text);
    expect(requestContents).toContain("Earlier continuity.");
    expect(requestContents).toContain("KEY_DETAILS_TO_RETAIN:");
    expect(responseMimeType).toBe("application/json");
    expect(responseSchema).toMatchObject({
      type: "object",
      required: ["continuityNote", "fragment", "sourceCoverage", "editorialChanges"],
    });
    expect(rendition.providerId).toBe("gemini-api");
    expect(rendition.promptVersion).toBe("gemini-json-v3");
    expect(rendition.fragment).toBe(mockText);
    expect(rendition.finishReason).toBe("STOP");
  });

  it("returns a validation-visible failure for a blocked Gemini response", async () => {
    const edition = await ingestUpload(resolve(root, "blood meridian.epub"));
    const sourceSpan = buildSourceSpan(edition, 0);
    const outputTarget = computeOutputTarget(sourceSpan.fragment.sourceWordCount);
    const provider = new GeminiProvider({
      apiKey: "test-key",
      client: {
        models: {
          async generateContent() {
            return { candidates: [{ finishReason: "SAFETY" }] } as unknown as GenerateContentResponse;
          },
        },
      },
    });

    const rendition = await provider.generate({
      sourceSpan,
      outputTarget,
      boundaryReference: {
        lastAllowedSourceAnchor: sourceSpan.endAnchor,
        instruction: "Do not use source material after the last allowed anchor.",
      },
    });
    expect(rendition.finishReason).toBe("SAFETY");
    const validation = validateRendition(sourceSpan, rendition);
    expect(validation.status).toBe("fail");
    expect(validation.checks.find((check) => check.id === "V9")?.status).toBe("fail");
  });

  it("does not accept a response without a completed candidate", async () => {
    const edition = await ingestUpload(resolve(root, "blood meridian.epub"));
    const sourceSpan = buildSourceSpan(edition, 0);
    const outputTarget = computeOutputTarget(sourceSpan.fragment.sourceWordCount);
    const provider = new GeminiProvider({
      apiKey: "test-key",
      client: {
        models: {
          async generateContent() {
            return {
              text: JSON.stringify({
                continuityNote: "",
                fragment: "An incomplete response.",
                sourceCoverage: { startAnchor: "start", endAnchor: "end" },
                editorialChanges: [],
              }),
              candidates: [],
            } as unknown as GenerateContentResponse;
          },
        },
      },
    });

    const rendition = await provider.generate({
      sourceSpan,
      outputTarget,
      boundaryReference: {
        lastAllowedSourceAnchor: sourceSpan.endAnchor,
        instruction: "Do not use source material after the last allowed anchor.",
      },
    });
    expect(rendition.finishReason).toBe("ERROR");
    const validation = validateRendition(sourceSpan, rendition);
    expect(validation.status).toBe("fail");
    expect(validation.checks.find((check) => check.id === "V9")?.status).toBe("fail");
  });

  it("does not require a key for literal verse preservation", async () => {
    const edition = await ingestUpload(resolve(root, "paradise lost.epub"));
    const fragmentIndex = edition.fragments.findIndex((fragment) => fragment.mode === "verse_verbatim");
    expect(fragmentIndex).toBeGreaterThanOrEqual(0);

    const result = await generateFragment(edition, fragmentIndex, new GeminiProvider());
    expect(result.rendition.variant).toBe("faithful_fallback");
    expect(normalizeWhitespace(result.rendition.fragment)).toBe(normalizeWhitespace(result.sourceSpan.text));
  });

  it("fails before a network call when Gemini has no API key", async () => {
    const edition = await ingestUpload(resolve(root, "blood meridian.epub"));
    const previousKey = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      await expect(generateFragment(edition, 0, new GeminiProvider())).rejects.toThrow(
        "Missing GEMINI_API_KEY",
      );
    } finally {
      if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = previousKey;
    }
  });
  it("does not flag common sentence-initial words as hallucinations in V3", async () => {
    const edition = await ingestUpload(resolve(root, "blood meridian.epub"));
    const sourceSpan = buildSourceSpan(edition, 0);

    // Realistic editorial compression using sentence starters like "Arriving", "Working", numbers like "1849"
    const validRendition = {
      fragmentId: sourceSpan.fragment.id,
      variant: "standard" as const,
      providerId: "test-provider",
      promptVersion: "test-v2",
      continuityNote: "",
      fragment: "The child runs away from Tennessee to New Orleans where he fights on the docks. Working his way to Galveston, he survives a gunshot wound. Arriving in Nacogdoches in 1849, he enters the tent of Reverend Green where Judge Holden suddenly appears.",
      sourceCoverage: {
        startAnchor: sourceSpan.startAnchor,
        endAnchor: sourceSpan.endAnchor,
      },
      editorialChanges: ["Compressed narrative."],
      finishReason: "STOP" as const,
    };

    const validation = validateRendition(sourceSpan, validRendition);
    expect(validation.checks.find((check) => check.id === "V3")?.status).toBe("pass");
  });

  it("triggers a single repair attempt on failure and accepts a compliant repair", async () => {
    const edition = await ingestUpload(resolve(root, "blood meridian.epub"));
    const sourceSpan = buildSourceSpan(edition, 0);
    let attempts = 0;
    let receivedRepairContext = false;

    const provider = {
      id: "repairing-provider",
      promptVersion: "test-v2",
      async generate(request: GenerationRequest) {
        attempts += 1;
        if (attempts === 1) {
          // First attempt: too short (fails V4)
          return {
            fragmentId: request.sourceSpan.fragment.id,
            variant: "standard" as const,
            providerId: "repairing-provider",
            promptVersion: "test-v2",
            continuityNote: "",
            fragment: "Too short.",
            sourceCoverage: {
              startAnchor: sourceSpan.startAnchor,
              endAnchor: sourceSpan.endAnchor,
            },
            editorialChanges: ["Initial try"],
            finishReason: "STOP" as const,
          };
        }

        // Repair attempt
        if (request.repairContext && request.repairContext.failedChecks.length > 0) {
          receivedRepairContext = true;
        }

        // Return a valid compression
        return {
          fragmentId: request.sourceSpan.fragment.id,
          variant: "standard" as const,
          providerId: "repairing-provider",
          promptVersion: "test-v2",
          continuityNote: "Arrives in Texas.",
          fragment: sourceSpan.text.slice(0, Math.floor(sourceSpan.text.length * 0.35)),
          sourceCoverage: {
            startAnchor: sourceSpan.startAnchor,
            endAnchor: sourceSpan.endAnchor,
          },
          editorialChanges: ["Repaired output."],
          finishReason: "STOP" as const,
        };
      },
    };

    const result = await generateFragment(edition, 0, provider);
    expect(attempts).toBe(2);
    expect(receivedRepairContext).toBe(true);
    expect(result.rendition.providerId).toBe("repairing-provider");
  });

  it("serves faithful fallback gracefully when repair attempt also fails", async () => {
    const edition = await ingestUpload(resolve(root, "blood meridian.epub"));
    const sourceSpan = buildSourceSpan(edition, 0);
    let attempts = 0;

    const failingProvider = {
      id: "failing-provider",
      promptVersion: "test-v2",
      async generate(request: GenerationRequest) {
        attempts += 1;
        // Always fail V2 anchor match
        return {
          fragmentId: request.sourceSpan.fragment.id,
          variant: "standard" as const,
          providerId: "failing-provider",
          promptVersion: "test-v2",
          continuityNote: "",
          fragment: "Always invalid.",
          sourceCoverage: {
            startAnchor: "invalid-anchor",
            endAnchor: sourceSpan.endAnchor,
          },
          editorialChanges: ["Broken coverage."],
          finishReason: "STOP" as const,
        };
      },
    };

    const result = await generateFragment(edition, 0, failingProvider);
    expect(attempts).toBe(2);
    expect(result.rendition.variant).toBe("faithful_fallback");
    expect(result.rendition.fragment).toBe(sourceSpan.text);
    expect(result.rendition.editorialChanges.some((c) => c.includes("Validation failed after repair"))).toBe(true);
    expect(result.validation.checks.find((check) => check.id === "V2")?.status).toBe("pass");
  });

  it("applies tiered V6 evaluation: pass at >=60%, warn at 45-59%, fail at <45%", async () => {
    const edition = await ingestUpload(resolve(root, "blood meridian.epub"));
    const sourceSpan = buildSourceSpan(edition, 0);

    // High retention (>=60%)
    const passRendition = {
      fragmentId: sourceSpan.fragment.id,
      variant: "standard" as const,
      providerId: "test-provider",
      promptVersion: "test-v3",
      continuityNote: "",
      fragment: sourceSpan.text.slice(0, 1000),
      sourceCoverage: { startAnchor: sourceSpan.startAnchor, endAnchor: sourceSpan.endAnchor },
      editorialChanges: [],
      finishReason: "STOP" as const,
    };
    const passValidation = validateRendition(sourceSpan, passRendition);
    expect(passValidation.checks.find((c) => c.id === "V6")?.status).toBe("pass");

    // Low retention (<45%)
    const lowRetentionText = "A solitary traveler walks through towns and cities without speaking. ".repeat(30);
    const failRendition = {
      ...passRendition,
      fragment: lowRetentionText,
    };
    const failValidation = validateRendition(sourceSpan, failRendition);
    expect(failValidation.checks.find((c) => c.id === "V6")?.status).toBe("fail");
  });
});

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}
