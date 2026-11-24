import { z } from "zod";

/** An omitted flag preserves existing values on older and partial edit forms. */
export const assetBorrowabilitySchema = z
  .enum(["true", "false"])
  .transform((value) => value === "true")
  .optional();
