import type { Block, FragmentMode, FragmentPlan } from "../core/types.js";

export type RenditionVariant = "standard" | "faithful_fallback";
export type ValidationStatus = "pass" | "review" | "fail";
export type ValidationCheckStatus = "pass" | "warn" | "fail";

export interface SourceSpan {
  /** Only the current fragment's source; never the full edition or future text. */
  fragment: FragmentPlan;
  blocks: Block[];
  text: string;
  mode: FragmentMode;
  startAnchor: string;
  endAnchor: string;
}

export interface GenerationRequest {
  sourceSpan: SourceSpan;
  previousContinuityNote?: string;
  boundaryReference: {
    lastAllowedSourceAnchor: string;
    nextSourceAnchor?: string;
    instruction: "Do not use source material after the last allowed anchor.";
  };
}

export interface FragmentRendition {
  fragmentId: string;
  variant: RenditionVariant;
  providerId: string;
  promptVersion: string;
  continuityNote: string;
  fragment: string;
  sourceCoverage: {
    startAnchor: string;
    endAnchor: string;
  };
  nextFragmentBeginsWith?: string;
  editorialChanges: string[];
  finishReason?: "STOP" | "SAFETY" | "RECITATION" | "ERROR";
}

export interface GenerationProvider {
  id: string;
  promptVersion: string;
  generate(request: GenerationRequest): Promise<FragmentRendition>;
}

export interface ValidationCheck {
  id: string;
  label: string;
  status: ValidationCheckStatus;
  message: string;
}

export interface ValidationReport {
  status: ValidationStatus;
  checks: ValidationCheck[];
  sourceWordCount: number;
  renditionWordCount: number;
  compressionRatio?: number;
}

export interface ValidationContext {
  previousContinuityNote?: string;
}

export interface GeneratedFragment {
  sourceSpan: SourceSpan;
  rendition: FragmentRendition;
  validation: ValidationReport;
}
