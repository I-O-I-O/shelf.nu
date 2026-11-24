import type { Location } from "@prisma/client";

export const REVIEW_CATEGORIES = [
  "Boards & Embedded Systems",
  "Components & Prototyping",
  "Motors, Power & Actuation",
  "Cables & Connectivity",
  "Tools & Fabrication",
  "Measurement & Lab Equipment",
  "Computing, AV & Imaging",
  "Kits & Complete Sets",
  "Old Projects / Legacy / Unknown",
  "Storage Infrastructure",
] as const;

export const REVIEW_TRACKING_TYPES = [
  "QUANTITY_TRACKED",
  "INDIVIDUAL",
  "KIT",
] as const;

export type ReviewDecision = "APPROVE" | "REJECT" | "NEEDS_MORE_INFO";

export type ReviewRecord = {
  candidate_id: string;
  human_decision: ReviewDecision;
  final_name: string;
  final_tracking_type: string;
  final_quantity: string;
  final_category: string;
  final_location_id: string;
  final_location_name: string;
  kit_decision: string;
  final_consumption_type?: string;
  human_note: string;
  reviewed_at: string;
  special_handling: string;
};

export type ReviewCandidate = {
  candidateId: string;
  sourceSheet: string;
  sourceRow: string;
  sourceItemName: string;
  originalQuantity: string;
  originalCategory: string;
  suggestedCategory: string;
  originalLocationText: string;
  duplicateClassification: string;
  kitClassification: string;
  proposedTrackingType: string;
  proposedQuantity: string;
  sourceClassification: string;
  proposedConsumptionType: string;
  proposedLocation: string;
  sourceNote: string;
};

export type ReviewLocation = Pick<Location, "id" | "name" | "parentId"> & {
  path: string;
};

export type ReviewState = {
  candidates: ReviewCandidate[];
  locations: ReviewLocation[];
  decisions: ReviewRecord[];
  diagnostics: ReviewDiagnostics;
};

export type ReviewDiagnostics = {
  processCwd: string;
  projectRoot: string;
  planPath: string;
  planExists: boolean;
  planBytes: number;
  parsedRows: number;
  status: "OK" | "MISSING" | "EMPTY";
  message: string;
};
