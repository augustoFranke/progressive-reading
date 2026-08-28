import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ingestUpload } from "../src/pipeline/ingestUpload.js";
import { GeminiProvider } from "../src/generate/geminiProvider.js";
import { generateFragment } from "../src/generate/generateFragment.js";
import { buildSourceSpan } from "../src/generate/sourceSpan.js";
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
                fragment: "A rider crosses the plain.",
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

    const result = await generateFragment(edition, 0, provider, { previousContinuityNote: "Earlier continuity." });

    expect(requestContents).toContain("SOURCE SPAN BEGIN");
    expect(requestContents).toContain("Do not use source material after the last allowed anchor.");
    expect(requestContents).toContain(sourceSpan.startAnchor);
    expect(requestContents).toContain(sourceSpan.endAnchor);
    expect(requestContents).toContain(`TARGET_READ_SECONDS: ${sourceSpan.fragment.targetReadSeconds}`);
    expect(requestContents).toContain(sourceSpan.text);
    expect(requestContents).toContain("Earlier continuity.");
    expect(responseMimeType).toBe("application/json");
    expect(responseSchema).toMatchObject({
      type: "object",
      required: ["continuityNote", "fragment", "sourceCoverage", "editorialChanges"],
    });
    expect(result.rendition.providerId).toBe("gemini-api");
    expect(result.rendition.fragment).toBe("A rider crosses the plain.");
    expect(result.rendition.finishReason).toBe("STOP");
  });

  it("returns a validation-visible failure for a blocked Gemini response", async () => {
    const edition = await ingestUpload(resolve(root, "blood meridian.epub"));
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

    const result = await generateFragment(edition, 0, provider);
    expect(result.rendition.finishReason).toBe("SAFETY");
    expect(result.validation.status).toBe("fail");
    expect(result.validation.checks.find((check) => check.id === "V9")?.status).toBe("fail");
  });

  it("does not accept a response without a completed candidate", async () => {
    const edition = await ingestUpload(resolve(root, "blood meridian.epub"));
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

    const result = await generateFragment(edition, 0, provider);
    expect(result.rendition.finishReason).toBe("ERROR");
    expect(result.validation.status).toBe("fail");
    expect(result.validation.checks.find((check) => check.id === "V9")?.status).toBe("fail");
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
});

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}
