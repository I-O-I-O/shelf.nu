import { useRef, useState } from "react";
import type { Prisma } from "@prisma/client";
import { isAuthApiError } from "@supabase/supabase-js";
import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import {
  data,
  Form,
  useActionData,
  useLoaderData,
  useNavigation,
} from "react-router";
import { z } from "zod";
import Input from "~/components/forms/input";
import { Card } from "~/components/shared/card";
import {
  changeEmailAddressHtmlEmail,
  changeEmailAddressTextEmail,
} from "~/emails/change-user-email-address";
import { sendEmail } from "~/emails/mail.server";
import { getSupabaseAdmin } from "~/integrations/supabase/client";
import {
  refreshAccessToken,
  signInWithEmail,
  updateAccountPassword,
} from "~/modules/auth/service.server";
import { assertEmailChangeAllowed } from "~/modules/auth/sso-enforcement.server";
import { requireStudentAccountSettings } from "~/modules/ioio-student/route.server";
import { getUserByID, updateUserEmail } from "~/modules/user/service.server";
import { makeShelfError, ShelfError } from "~/utils/error";
import { error, payload } from "~/utils/http.server";

const accountActionSchema = z.union([
  z.object({
    intent: z.literal("change-email"),
    currentPassword: z.string().min(1, "Enter your current password."),
    newEmail: z.string().email("Enter a valid email address."),
  }),
  z.object({
    intent: z.literal("change-password"),
    newPassword: z
      .string()
      .min(6, "Your new password must be at least 6 characters."),
    confirmPassword: z.string().min(1, "Confirm your new password."),
  }),
  z.object({
    intent: z.literal("verify-email"),
    newEmail: z.string().email("Enter a valid email address."),
    otp: z
      .string()
      .min(6, "Code must be 6 digits")
      .max(6, "Code must be 6 digits"),
  }),
]);

export async function loader({ context, request }: LoaderFunctionArgs) {
  const auth = await requireStudentAccountSettings({ context, request });
  const user = await getUserByID(auth.userId, {
    select: { email: true, sso: true },
  } satisfies { select: Prisma.UserSelect });
  return payload({ email: user.email, sso: user.sso });
}

export async function action({ context, request }: ActionFunctionArgs) {
  const authSession = context.getSession();
  const { userId, email, accessToken } = authSession;
  try {
    await requireStudentAccountSettings({ context, request });
    const parsed = accountActionSchema.parse(
      Object.fromEntries(await request.formData())
    );

    if (
      parsed.intent === "change-password" &&
      parsed.newPassword !== parsed.confirmPassword
    ) {
      return data({
        error: { message: "New passwords do not match.", label: "Auth" },
      });
    }

    if (parsed.intent === "change-email" && parsed.newEmail === email) {
      return data({
        error: { message: "Enter a different email address.", label: "Auth" },
      });
    }

    if (parsed.intent === "change-email") {
      const verification = await signInWithEmail(email, parsed.currentPassword);
      if (!verification || "requiresEmailVerification" in verification) {
        return data({
          error: {
            message: "Your current password could not be verified.",
            label: "Auth",
          },
        });
      }

      await assertEmailChangeAllowed({ userId, email });
      const user = await getUserByID(userId, {
        select: {
          email: true,
          firstName: true,
          lastName: true,
          displayName: true,
        } satisfies Prisma.UserSelect,
      });
      const { data: linkData, error: generateError } =
        await getSupabaseAdmin().auth.admin.generateLink({
          type: "email_change_new",
          email,
          newEmail: parsed.newEmail,
        });
      if (generateError) {
        if (generateError.code === "email_exists") {
          return data(
            {
              error: {
                message:
                  "Please choose a different email address which is not already in use.",
                label: "Auth",
              },
            },
            { status: 400 }
          );
        }

        throw new ShelfError({
          cause: generateError,
          message: "Failed to initiate email change.",
          additionalData: { userId, newEmail: parsed.newEmail },
          label: "Auth",
        });
      }
      const otp = linkData.properties.email_otp;
      sendEmail({
        to: parsed.newEmail,
        subject: `🔐 Shelf verification code: ${otp}`,
        text: changeEmailAddressTextEmail({ otp, user }),
        html: await changeEmailAddressHtmlEmail(otp, user),
      });
      return data({
        awaitingEmailVerification: true as const,
        newEmail: parsed.newEmail,
        message: `A verification code was sent to ${parsed.newEmail}.`,
      });
    }

    if (parsed.intent === "verify-email") {
      await assertEmailChangeAllowed({ userId, email });
      const { error: verifyError } = await getSupabaseAdmin().auth.verifyOtp({
        email: parsed.newEmail,
        token: parsed.otp,
        type: "email_change",
      });
      if (verifyError) {
        if (isAuthApiError(verifyError) && verifyError.code === "otp_expired") {
          return data(
            {
              error: {
                message: "Invalid or expired verification code",
                label: "Auth",
              },
            },
            { status: 400 }
          );
        }

        throw new ShelfError({
          cause: verifyError,
          message: "Failed to verify email change code.",
          additionalData: { userId, newEmail: parsed.newEmail },
          label: "Auth",
        });
      }
      await updateUserEmail({
        userId,
        currentEmail: email,
        newEmail: parsed.newEmail,
      });
      const newSession = await refreshAccessToken(authSession.refreshToken);
      context.setSession(newSession);
      await getSupabaseAdmin().auth.admin.signOut(
        newSession.accessToken,
        "others"
      );
      return data({
        ok: true as const,
        kind: "email" as const,
        message: `Your email address is now ${parsed.newEmail}.`,
      });
    }

    await updateAccountPassword(userId, parsed.newPassword, accessToken);
    const newSession = await signInWithEmail(email, parsed.newPassword);
    if (newSession) context.setSession(newSession);
    return data({
      ok: true as const,
      kind: "password" as const,
      message: newSession
        ? "Your password has been changed."
        : "Your password has been changed. Please sign in again.",
    });
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    return data(error(reason), { status: reason.status });
  }
}

export const meta: MetaFunction = () => [{ title: "Account settings" }];

export default function StudentAccountSettings() {
  const { email, sso } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const [pendingEmail, setPendingEmail] = useState<string | null>(null);
  const lastProcessedActionRef = useRef<typeof actionData | null>(null);
  if (actionData && lastProcessedActionRef.current !== actionData) {
    lastProcessedActionRef.current = actionData;

    if ("awaitingEmailVerification" in actionData) {
      queueMicrotask(() => setPendingEmail(actionData.newEmail));
    } else if ("ok" in actionData && actionData.kind === "email") {
      queueMicrotask(() => setPendingEmail(null));
    }
  }
  const navigation = useNavigation();
  const isSubmitting = navigation.state !== "idle";
  const errorMessage =
    actionData && "error" in actionData ? actionData.error?.message : null;
  const successMessage =
    actionData && "message" in actionData ? actionData.message : null;
  const emailAwaitingVerification = pendingEmail;

  return (
    <div className="max-w-3xl space-y-5">
      {errorMessage ? (
        <p
          role="alert"
          className="rounded-xl bg-red-50 px-4 py-3 text-sm font-semibold text-red-800"
        >
          {errorMessage}
        </p>
      ) : null}
      {successMessage ? (
        <p
          role="status"
          className="rounded-xl bg-green-50 px-4 py-3 text-sm font-semibold text-green-800"
        >
          {successMessage}
        </p>
      ) : null}

      <Card className="my-0 rounded-2xl p-5 shadow-sm">
        <div>
          <h2 className="text-xl font-black text-gray-950">Account</h2>
          <p className="mt-1 text-sm text-gray-600">
            Manage your sign-in details.
          </p>
        </div>
        <dl className="mt-5">
          <dt className="text-xs font-bold uppercase tracking-wide text-gray-500">
            Email
          </dt>
          <dd className="mt-1 break-words text-sm font-semibold text-gray-950">
            {email}
          </dd>
        </dl>
        {sso ? (
          <p className="mt-4 rounded-xl bg-gray-50 px-4 py-3 text-sm text-gray-600">
            This account is managed by your organization&apos;s sign-in
            provider. Email and password changes are unavailable here.
          </p>
        ) : (
          <>
            {emailAwaitingVerification ? (
              <Form
                method="post"
                className="mt-6 space-y-4 border-t border-gray-100 pt-5"
              >
                <input type="hidden" name="intent" value="verify-email" />
                <input
                  type="hidden"
                  name="newEmail"
                  value={emailAwaitingVerification}
                />
                <h3 className="text-sm font-black text-gray-950">
                  Verify your new email
                </h3>
                <p className="text-sm text-gray-600">
                  Enter the verification code sent to{" "}
                  {emailAwaitingVerification}.
                </p>
                <Input
                  label="Verification code"
                  name="otp"
                  type="text"
                  placeholder="Enter 6-digit code"
                  autoComplete="one-time-code"
                  maxLength={6}
                  required
                  className="mt-1"
                />
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="rounded-xl bg-red-700 px-4 py-2.5 text-sm font-bold text-white hover:bg-red-800 focus:outline-none focus:ring-2 focus:ring-red-700 focus:ring-offset-2 disabled:cursor-wait disabled:bg-gray-300"
                >
                  {isSubmitting ? "Verifying..." : "Verify email"}
                </button>
              </Form>
            ) : (
              <Form
                method="post"
                className="mt-6 space-y-4 border-t border-gray-100 pt-5"
              >
                <input type="hidden" name="intent" value="change-email" />
                <h3 className="text-sm font-black text-gray-950">
                  Change email
                </h3>
                <Input
                  label="New email address"
                  name="newEmail"
                  type="email"
                  autoComplete="email"
                  required
                  className="mt-1"
                />
                <Input
                  label="Current password"
                  name="currentPassword"
                  type="password"
                  autoComplete="current-password"
                  required
                  className="mt-1"
                />
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="rounded-xl bg-red-700 px-4 py-2.5 text-sm font-bold text-white hover:bg-red-800 focus:outline-none focus:ring-2 focus:ring-red-700 focus:ring-offset-2 disabled:cursor-wait disabled:bg-gray-300"
                >
                  {isSubmitting ? "Saving..." : "Change email"}
                </button>
              </Form>
            )}

            <Form
              method="post"
              className="mt-6 space-y-4 border-t border-gray-100 pt-5"
            >
              <input type="hidden" name="intent" value="change-password" />
              <h3 className="text-sm font-black text-gray-950">
                Change password
              </h3>
              <Input
                label="New password"
                name="newPassword"
                type="password"
                autoComplete="new-password"
                required
                className="mt-1"
              />
              <Input
                label="Confirm new password"
                name="confirmPassword"
                type="password"
                autoComplete="new-password"
                required
                className="mt-1"
              />
              <button
                type="submit"
                disabled={isSubmitting}
                className="rounded-xl bg-red-700 px-4 py-2.5 text-sm font-bold text-white hover:bg-red-800 focus:outline-none focus:ring-2 focus:ring-red-700 focus:ring-offset-2 disabled:cursor-wait disabled:bg-gray-300"
              >
                {isSubmitting ? "Saving..." : "Change password"}
              </button>
            </Form>
          </>
        )}
      </Card>
    </div>
  );
}
