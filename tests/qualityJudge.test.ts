import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ingestUpload } from "../src/pipeline/ingestUpload.js";
import { generateFragment } from "../src/generate/generateFragment.js";
import { buildSourceSpan } from "../src/generate/sourceSpan.js";
import { GeminiQualityJudge, LocalQualityJudge } from "../src/generate/qualityJudge.js";
import type { GenerateContentResponse } from "@google/genai";
import type { GenerationRequest, QualityJudge } from "../src/generate/types.js";

const root = resolve(import.meta.dirname, "..");

describe("LLM Quality Judge Quality Gate", () => {
  it("evaluates a standard rendition with LocalQualityJudge", async () => {
    const edition = await ingestUpload(resolve(root, "blood meridian.epub"));
    const sourceSpan = buildSourceSpan(edition, 0);

    const judge = new LocalQualityJudge();
    const mockRendition = {
      fragmentId: sourceSpan.fragment.id,
      variant: "standard" as const,
      providerId: "test-provider",
      promptVersion: "test-v3",
      continuityNote: "The child rides into Texas.",
      fragment: "The child runs away from Tennessee to New Orleans where he fights on the docks. ".repeat(30).trim(),
      sourceCoverage: { startAnchor: sourceSpan.startAnchor, endAnchor: sourceSpan.endAnchor },
      editorialChanges: [],
      finishReason: "STOP" as const,
    };

    const report = await judge.evaluate(sourceSpan, mockRendition);
    expect(report.status).toBe("pass");
    expect(report.score).toBeGreaterThanOrEqual(70);
    expect(report.voiceFidelityScore).toBeGreaterThanOrEqual(3);
    expect(report.scenePreservationScore).toBeGreaterThanOrEqual(3);
  });

  it("fails ultra-short synopsis with LocalQualityJudge", async () => {
    const edition = await ingestUpload(resolve(root, "blood meridian.epub"));
    const sourceSpan = buildSourceSpan(edition, 0);

    const judge = new LocalQualityJudge();
    const synopsisRendition = {
      fragmentId: sourceSpan.fragment.id,
      variant: "standard" as const,
      providerId: "test-provider",
      promptVersion: "test-v3",
      continuityNote: "",
      fragment: "The kid leaves home, goes to Texas, and meets the judge.",
      sourceCoverage: { startAnchor: sourceSpan.startAnchor, endAnchor: sourceSpan.endAnchor },
      editorialChanges: [],
      finishReason: "STOP" as const,
    };

    const report = await judge.evaluate(sourceSpan, synopsisRendition);
    expect(report.status).toBe("fail");
    expect(report.score).toBeLessThan(50);
    expect(report.critique.length).toBeGreaterThan(0);
  });

  it("parses structured GeminiQualityJudge evaluation response", async () => {
    const edition = await ingestUpload(resolve(root, "blood meridian.epub"));
    const sourceSpan = buildSourceSpan(edition, 0);

    const mockResponse: GenerateContentResponse = {
      text: JSON.stringify({
        status: "pass",
        score: 88,
        voiceFidelityScore: 5,
        scenePreservationScore: 4,
        summaryResistanceScore: 5,
        critique: ["Preserves McCarthy's grim Biblical cadence accurately."],
        suggestedImprovements: [],
      }),
      candidates: [{ finishReason: "STOP" }],
    } as unknown as GenerateContentResponse;

    let capturedContents = "";
    const judge = new GeminiQualityJudge({
      apiKey: "test-key",
      client: {
        models: {
          async generateContent(parameters: { contents?: unknown }) {
            capturedContents = String(parameters.contents);
            return mockResponse;
          },
        },
      },
    });

    const mockRendition = {
      fragmentId: sourceSpan.fragment.id,
      variant: "standard" as const,
      providerId: "test-provider",
      promptVersion: "test-v3",
      continuityNote: "",
      fragment: "See the child. He stokes the fire.",
      sourceCoverage: { startAnchor: sourceSpan.startAnchor, endAnchor: sourceSpan.endAnchor },
      editorialChanges: [],
      finishReason: "STOP" as const,
    };

    const report = await judge.evaluate(sourceSpan, mockRendition);
    expect(capturedContents).toContain("ORIGINAL SOURCE SPAN BEGIN");
    expect(capturedContents).toContain("EDITORIAL RENDITION TO EVALUATE BEGIN");
    expect(report.status).toBe("pass");
    expect(report.score).toBe(88);
    expect(report.voiceFidelityScore).toBe(5);
  });

  it("integrates judge into generateFragment and feeds judge critique to repair loop", async () => {
    const edition = await ingestUpload(resolve(root, "blood meridian.epub"));
    const sourceSpan = buildSourceSpan(edition, 0);

    let repairReceivedJudgeCritique = false;
    let attempts = 0;

    const provider = {
      id: "mock-provider",
      promptVersion: "test-v3",
      async generate(request: GenerationRequest) {
        attempts++;
        if (attempts === 1) {
          return {
            fragmentId: request.sourceSpan.fragment.id,
            variant: "standard" as const,
            providerId: "mock-provider",
            promptVersion: "test-v3",
            continuityNote: "",
            fragment: "Tennessee Memphis Saint Louis New Orleans Galveston Fredonia Nacogdoches Reverend Green Judge Holden Maltese 1849 33 14 42 7 ".repeat(25).trim(),
            sourceCoverage: { startAnchor: sourceSpan.startAnchor, endAnchor: sourceSpan.endAnchor },
            editorialChanges: [],
            finishReason: "STOP" as const,
          };
        }

        if (request.repairContext?.judgeCritique?.includes("Lacks authorial grit")) {
          repairReceivedJudgeCritique = true;
        }

        return {
          fragmentId: request.sourceSpan.fragment.id,
          variant: "standard" as const,
          providerId: "mock-provider",
          promptVersion: "test-v3",
          continuityNote: "The child rides into Texas.",
          fragment: "Tennessee Memphis Saint Louis New Orleans Galveston Fredonia Nacogdoches Reverend Green Judge Holden Maltese 1849 33 14 42 7 ".repeat(10).trim(),
          sourceCoverage: { startAnchor: sourceSpan.startAnchor, endAnchor: sourceSpan.endAnchor },
          editorialChanges: ["Polished with judge critique."],
          finishReason: "STOP" as const,
        };
      },
    };

    let judgeEvaluations = 0;
    const mockJudge: QualityJudge = {
      id: "mock-judge",
      async evaluate() {
        judgeEvaluations++;
        if (judgeEvaluations === 1) {
          return {
            status: "fail",
            score: 45,
            voiceFidelityScore: 2,
            scenePreservationScore: 2,
            summaryResistanceScore: 2,
            critique: ["Lacks authorial grit", "Omits key dialogue in tent."],
            suggestedImprovements: ["Restore authorial vocabulary."],
          };
        }
        return {
          status: "pass",
          score: 90,
          voiceFidelityScore: 5,
          scenePreservationScore: 5,
          summaryResistanceScore: 5,
          critique: ["Excellent recovery."],
          suggestedImprovements: [],
        };
      },
    };

    const result = await generateFragment(edition, 0, provider, { judge: mockJudge });

    expect(attempts).toBe(2);
    expect(judgeEvaluations).toBe(2);
    expect(repairReceivedJudgeCritique).toBe(true);
    expect(result.judgeReport?.status).toBe("pass");
    expect(result.judgeReport?.score).toBe(90);
  });
});
