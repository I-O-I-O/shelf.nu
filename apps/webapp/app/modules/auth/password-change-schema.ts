import { z } from "zod";
import { passwordSchema } from "~/utils/zod";

export function createPasswordChangeSchema<
  ExtraFields extends z.ZodRawShape = {},
>(extraFields: ExtraFields = {} as ExtraFields) {
  return z
    .object({
      currentPassword: z.preprocess(
        (value) => value ?? "",
        z.string().min(1, "Current password is required.")
      ),
      newPassword: z.preprocess(
        (value) => value ?? "",
        passwordSchema("Password is too short. Minimum 8 characters.")
      ),
      confirmPassword: z.preprocess(
        (value) => value ?? "",
        passwordSchema("Password is too short. Minimum 8 characters.")
      ),
      ...extraFields,
    })
    .superRefine(({ newPassword, confirmPassword }, ctx) => {
      if (newPassword !== confirmPassword) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "New password and confirmation must match.",
          path: ["confirmPassword"],
        });
      }
    });
}

export const PasswordChangeSchema = createPasswordChangeSchema();
