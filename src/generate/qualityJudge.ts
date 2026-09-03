import { GoogleGenAI } from "@google/genai";
import type { GenerateContentResponse } from "@google/genai";
import type {
  FragmentRendition,
  QualityJudge,
  QualityJudgeReport,
  SourceSpan,
  ValidationContext,
} from "./types.js";

const DEFAULT_JUDGE_MODEL = "gemini-3.5-flash-lite";

const JUDGE_SYSTEM_INSTRUCTION = [
  "You are an expert literary quality judge evaluating an editorial compression of a classic or literary book chapter.",
  "Your role is to assess whether the compressed fragment authentically preserves the author's distinctive voice, prose style, concrete scenes, and narrative power, rather than reading like an artificial, generic LLM synopsis.",
  "Evaluate along three key dimensions on a 1-5 scale (1 = terrible/generic synopsis, 5 = masterfully faithful literary editorial work):",
  "1. voiceFidelityScore (1-5): Does it sound like the author's own vocabulary, cadence, and atmosphere, or does it sound like sanitized AI prose?",
  "2. scenePreservationScore (1-5): Does it preserve concrete scenes, actions, sensory details, and dialogues in sequence without skipping major dramatic beats?",
  "3. summaryResistanceScore (1-5): Does it avoid high-level summarizing generalizations (e.g., 'he travelled and fought') and maintain the immediacy of direct literature?",
  "Calculate an overall score (0 to 100) combining these dimensions.",
  "Assign status:",
  "- 'pass': score >= 70, with all dimensions >= 3.",
  "- 'review': score between 50 and 69 (acceptable for reading with minor editorial notes).",
  "- 'fail': score < 50 or any dimension < 2 (unacceptable synopsis or destroyed authorial voice).",
  "Provide specific, actionable critique points in the critique array.",
  "Return only valid JSON matching the requested schema without markdown code blocks.",
].join(" ");

const JUDGE_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    status: {
      type: "string",
      enum: ["pass", "review", "fail"],
      description: "Overall judgment status",
    },
    score: {
      type: "integer",
      description: "Quality score from 0 to 100",
    },
    voiceFidelityScore: {
      type: "integer",
      description: "Authorial voice fidelity from 1 to 5",
    },
    scenePreservationScore: {
      type: "integer",
      description: "Scene-level concrete preservation from 1 to 5",
    },
    summaryResistanceScore: {
      type: "integer",
      description: "Resistance to generic summarization from 1 to 5",
    },
    critique: {
      type: "array",
      items: { type: "string" },
      description: "Specific literary critique points",
    },
    suggestedImprovements: {
      type: "array",
      items: { type: "string" },
      description: "Concrete editorial improvements",
    },
  },
  required: [
    "status",
    "score",
    "voiceFidelityScore",
    "scenePreservationScore",
    "summaryResistanceScore",
    "critique",
    "suggestedImprovements",
  ],
};

export interface GeminiQualityJudgeOptions {
  apiKey?: string;
  model?: string;
  client?: {
    models: {
      generateContent(parameters: unknown): Promise<GenerateContentResponse>;
    };
  };
}

export class GeminiQualityJudge implements QualityJudge {
  readonly id = "gemini-quality-judge-v1";
  readonly model: string;
  private readonly apiKey?: string;
  private client?: {
    models: {
      generateContent(parameters: unknown): Promise<GenerateContentResponse>;
    };
  };

  constructor(options: GeminiQualityJudgeOptions = {}) {
    this.apiKey = options.apiKey;
    this.client = options.client;
    this.model = options.model ?? process.env.GEMINI_JUDGE_MODEL ?? process.env.GEMINI_MODEL ?? DEFAULT_JUDGE_MODEL;
  }

  async evaluate(
    sourceSpan: SourceSpan,
    rendition: FragmentRendition,
    context: ValidationContext = {},
  ): Promise<QualityJudgeReport> {
    if (rendition.variant === "faithful_fallback" || sourceSpan.mode === "verse_verbatim") {
      return {
        status: "pass",
        score: 100,
        voiceFidelityScore: 5,
        scenePreservationScore: 5,
        summaryResistanceScore: 5,
        critique: ["Verbatim source text preserved literally."],
        suggestedImprovements: [],
      };
    }

    const prompt = buildJudgePrompt(sourceSpan, rendition, context);
    const client = this.getClient();

    const response = await client.models.generateContent({
      model: this.model,
      contents: prompt,
      config: {
        systemInstruction: JUDGE_SYSTEM_INSTRUCTION,
        responseMimeType: "application/json",
        responseJsonSchema: JUDGE_RESPONSE_SCHEMA,
        temperature: 0.1,
        maxOutputTokens: 1500,
      },
    });

    const text = response.text?.trim();
    if (!text) {
      throw new Error("Gemini Quality Judge returned an empty evaluation response");
    }

    return parseJudgeResponse(text);
  }

  private getClient() {
    if (this.client) return this.client;
    const apiKey = this.apiKey?.trim() || process.env.GEMINI_API_KEY?.trim();
    if (!apiKey) {
      throw new Error("Missing GEMINI_API_KEY for Quality Judge evaluation");
    }
    this.client = new GoogleGenAI({ apiKey });
    return this.client;
  }
}

export class LocalQualityJudge implements QualityJudge {
  readonly id = "local-heuristic-judge-v1";

  async evaluate(
    sourceSpan: SourceSpan,
    rendition: FragmentRendition,
  ): Promise<QualityJudgeReport> {
    if (rendition.variant === "faithful_fallback" || sourceSpan.mode === "verse_verbatim") {
      return {
        status: "pass",
        score: 100,
        voiceFidelityScore: 5,
        scenePreservationScore: 5,
        summaryResistanceScore: 5,
        critique: ["Verbatim source text preserved literally."],
        suggestedImprovements: [],
      };
    }

    const sourceWords = sourceSpan.text.trim().split(/\s+/u).length;
    const renditionWords = rendition.fragment.trim().split(/\s+/u).length;
    const ratio = renditionWords / Math.max(1, sourceWords);

    if (ratio < 0.15) {
      return {
        status: "fail",
        score: 40,
        voiceFidelityScore: 2,
        scenePreservationScore: 2,
        summaryResistanceScore: 2,
        critique: ["Fragment is too heavily compressed into a synopsis, losing scene texture."],
        suggestedImprovements: ["Expand compressed scenes and retain concrete actions and dialogue."],
      };
    }

    if (ratio > 0.65) {
      return {
        status: "review",
        score: 68,
        voiceFidelityScore: 4,
        scenePreservationScore: 4,
        summaryResistanceScore: 3,
        critique: ["Fragment contains slight verbosity."],
        suggestedImprovements: ["Trim non-essential secondary clauses."],
      };
    }

    return {
      status: "pass",
      score: 85,
      voiceFidelityScore: 4,
      scenePreservationScore: 4,
      summaryResistanceScore: 4,
      critique: ["Rendition successfully balances narrative compression with authorial texture."],
      suggestedImprovements: [],
    };
  }
}

export function buildJudgePrompt(
  sourceSpan: SourceSpan,
  rendition: FragmentRendition,
  context: ValidationContext = {},
): string {
  return [
    "Evaluate the following editorial compression against the original source book excerpt.",
    `FRAGMENT_ID: ${JSON.stringify(sourceSpan.fragment.id)}`,
    `SOURCE_WORD_COUNT: ${sourceSpan.fragment.sourceWordCount}`,
    `RENDITION_WORD_COUNT: ${rendition.fragment.trim().split(/\s+/u).length}`,
    `PREVIOUS_CONTINUITY_NOTE: ${JSON.stringify(context.previousContinuityNote || "none")}`,
    "",
    "--- ORIGINAL SOURCE SPAN BEGIN ---",
    sourceSpan.text,
    "--- ORIGINAL SOURCE SPAN END ---",
    "",
    "--- EDITORIAL RENDITION TO EVALUATE BEGIN ---",
    rendition.fragment,
    "--- EDITORIAL RENDITION TO EVALUATE END ---",
  ].join("\n");
}

function parseJudgeResponse(text: string): QualityJudgeReport {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Failed to parse Quality Judge JSON response");
  }

  if (
    typeof value !== "object" ||
    value === null ||
    !("status" in value) ||
    !("score" in value) ||
    !("voiceFidelityScore" in value) ||
    !("scenePreservationScore" in value) ||
    !("summaryResistanceScore" in value)
  ) {
    throw new Error("Quality Judge response is missing required score fields");
  }

  const v = value as Record<string, unknown>;
  const status = v.status === "pass" || v.status === "review" || v.status === "fail" ? v.status : "review";

  return {
    status,
    score: typeof v.score === "number" ? v.score : 70,
    voiceFidelityScore: typeof v.voiceFidelityScore === "number" ? v.voiceFidelityScore : 3,
    scenePreservationScore: typeof v.scenePreservationScore === "number" ? v.scenePreservationScore : 3,
    summaryResistanceScore: typeof v.summaryResistanceScore === "number" ? v.summaryResistanceScore : 3,
    critique: Array.isArray(v.critique) ? v.critique.map(String) : [],
    suggestedImprovements: Array.isArray(v.suggestedImprovements) ? v.suggestedImprovements.map(String) : [],
  };
}
