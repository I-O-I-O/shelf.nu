import { z } from "zod";

export const BulkUndoOperationSchema = z.enum([
  "category",
  "location",
  "archive",
  "trash",
]);

export const BulkUndoEntrySchema = z.object({
  assetId: z.string().min(1),
  previousCategoryId: z.string().nullable().optional(),
  expectedCategoryId: z.string().nullable().optional(),
  previousLocationId: z.string().nullable().optional(),
  expectedLocationId: z.string().nullable().optional(),
});

export const BulkUndoSchema = z.object({
  operation: BulkUndoOperationSchema,
  createdAt: z.number().int().positive(),
  entries: z.array(BulkUndoEntrySchema).min(1).max(100),
});

export type BulkUndoRequest = z.infer<typeof BulkUndoSchema>;

export type BulkMutationUndo = {
  operation: z.infer<typeof BulkUndoOperationSchema>;
  targetCategoryId?: string | null;
  targetLocationId?: string | null;
};
