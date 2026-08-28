export type SourceFormat = "epub" | "pdf";

export type BlockKind =
  | "heading"
  | "paragraph"
  | "verse_line"
  | "list_item"
  | "blockquote"
  | "caption"
  | "footnote"
  | "epigraph"
  | "figure"
  | "furniture";

export type StructureKind = "part" | "chapter" | "section";
export type Role = "work" | "front_matter" | "back_matter" | "apparatus";
export type FragmentMode = "prose_compressed" | "verse_verbatim";
export type EvidenceLevel = "high" | "medium" | "low";

export interface BookMetadata {
  title: string;
  author?: string;
  language?: string;
}

export interface SpineDocument {
  index: number;
  id: string;
  href: string;
  mediaType: string;
  title?: string;
}

export interface Block {
  ordinal: number;
  spineIndex: number;
  sourceHref: string;
  sourceAnchor: string;
  kind: BlockKind;
  text: string;
  sourceRoleHint?: string;
  headingLevel?: number;
  stanzaId?: string;
  printPage?: number;
}

export interface StructureNode {
  id: string;
  kind: StructureKind;
  ordinal: number;
  title: string;
  path: string;
  blockStart: number;
  blockEnd: number;
  role: Role;
  roleSource: string;
  detectionSource: string;
  /** Qualitative evidence level for the assigned role; this is not a probability. */
  evidenceLevel: EvidenceLevel;
  parentId?: string;
  children: StructureNode[];
}

export interface FragmentPlan {
  id: string;
  nodeId: string;
  indexInNode: number;
  globalIndex: number;
  mode: FragmentMode;
  blockStart: number;
  blockEnd: number;
  sourceWordCount: number;
  targetReadSeconds: number;
}

export interface QualityReport {
  status: "ready" | "needs_review" | "failed";
  errors: string[];
  warnings: string[];
  blockCount: number;
  workBlockCount: number;
  structureNodeCount: number;
  fragmentCount: number;
  coverage: {
    passed: boolean;
    expectedBlockCount: number;
    plannedBlockCount: number;
  };
}

export interface Edition {
  pipelineVersion: string;
  sourceFormat: SourceFormat;
  sourcePath: string;
  metadata: BookMetadata;
  spine: SpineDocument[];
  blocks: Block[];
  structure: StructureNode[];
  fragments: FragmentPlan[];
  quality: QualityReport;
}
