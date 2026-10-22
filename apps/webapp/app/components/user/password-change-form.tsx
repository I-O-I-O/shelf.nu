import { useActionData } from "react-router";
import { useZorm } from "react-zorm";
import { useDisabled } from "~/hooks/use-disabled";
import { PasswordChangeSchema } from "~/modules/auth/password-change-schema";
import type { UserPageActionData } from "~/routes/_layout+/account-details.general";
import { getValidationErrors } from "~/utils/http";
import { Form } from "../custom-form";
import PasswordInput from "../forms/password-input";
import { Button } from "../shared/button";

export default function PasswordChangeForm() {
  const zo = useZorm("ChangePasswordForm", PasswordChangeSchema);
  const actionData = useActionData<UserPageActionData>();
  const disabled = useDisabled();
  const validationErrors = getValidationErrors<typeof PasswordChangeSchema>(
    actionData?.error
  );
  const resetRequested = Boolean(
    actionData &&
      "resetEmailRequested" in actionData &&
      actionData.resetEmailRequested
  );

  return (
    <div className="space-y-4">
      <Form ref={zo.ref} method="post" className="space-y-3">
        <input type="hidden" name="intent" value="changePassword" />
        <input type="hidden" name="type" value="changePassword" />

        <PasswordInput
          label="Current password"
          name={zo.fields.currentPassword()}
          autoComplete="current-password"
          placeholder="Enter your current password"
          required
          disabled={disabled}
          error={
            validationErrors?.currentPassword?.message ||
            zo.errors.currentPassword()?.message
          }
        />
        <PasswordInput
          label="New password"
          name={zo.fields.newPassword()}
          autoComplete="new-password"
          placeholder="Choose a new password"
          required
          disabled={disabled}
          error={
            validationErrors?.newPassword?.message ||
            zo.errors.newPassword()?.message
          }
        />
        <PasswordInput
          label="Confirm new password"
          name={zo.fields.confirmPassword()}
          autoComplete="new-password"
          placeholder="Confirm your new password"
          required
          disabled={disabled}
          error={
            validationErrors?.confirmPassword?.message ||
            zo.errors.confirmPassword()?.message
          }
        />

        {actionData?.error ? (
          <p role="alert" className="text-sm text-red-600">
            {actionData.error.message}
          </p>
        ) : null}

        <Button
          data-test-id="change-password"
          type="submit"
          disabled={disabled}
        >
          {disabled ? "Changing password…" : "Change password"}
        </Button>
      </Form>

      <div className="border-t border-gray-200 pt-3">
        <p className="text-sm text-gray-600">Forgot your current password?</p>
        <Form method="post" className="mt-1">
          <input type="hidden" name="intent" value="requestPasswordReset" />
          <input type="hidden" name="type" value="requestPasswordReset" />
          <Button
            data-test-id="reset-password-by-email"
            type="submit"
            variant="link"
            disabled={disabled}
          >
            Reset password by email
          </Button>
        </Form>
        {resetRequested ? (
          <p role="status" className="text-sm text-green-700">
            If your account can use a password, a reset email has been sent.
          </p>
        ) : null}
      </div>
    </div>
  );
}
