import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import {
  data,
  redirect,
  useActionData,
  useFetcher,
  useLoaderData,
} from "react-router";
import { useZorm } from "react-zorm";
import { z } from "zod";
import { Form } from "~/components/custom-form";
import { ShelfOTP } from "~/components/forms/otp-input";
import { IoioAuthPrimaryButton } from "~/components/ioio/auth-primary-button";
import { Button } from "~/components/shared/button";
import { useSearchParams } from "~/hooks/search-params";
import { useDisabled } from "~/hooks/use-disabled";
import { verifyOtpAndSignin } from "~/modules/auth/service.server";
import { isSsoDomainEmail } from "~/modules/auth/sso-enforcement.server";
import { ensureInitialIoioTeamForUser } from "~/modules/ioio/initial-team.server";
import {
  getSelectedOrganization,
  setSelectedOrganizationIdCookie,
} from "~/modules/organization/context.server";
import {
  readSignupIntent,
  signupIntentHeaders,
} from "~/modules/signup-intent/cookie.server";
import { createUser, findUserById } from "~/modules/user/service.server";
import { generateUniqueUsername } from "~/modules/user/utils.server";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import { detectFormatPrefsForPersistence } from "~/utils/client-hints";
import { setCookie } from "~/utils/cookies.server";
import { ShelfError, makeShelfError, notAllowedMethod } from "~/utils/error";
import { isFormProcessing } from "~/utils/form";
import {
  payload,
  error,
  getActionMethod,
  parseData,
  safeRedirect,
} from "~/utils/http.server";
import {
  resolveIoioAccountDestination,
  resolveIoioAccountMembership,
} from "~/utils/ioio-role-routing";
import { validEmail } from "~/utils/misc";
import { getOtpPageData, type OtpVerifyMode } from "~/utils/otp";
import { tw } from "~/utils/tw";
import type { action as resendOtpAction } from "./resend-otp";

export async function loader({ context, request }: LoaderFunctionArgs) {
  const { searchParams } = new URL(request.url);
  const mode = searchParams.get("mode") as OtpVerifyMode;
  const title = getOtpPageData(mode).title;

  if (context.isAuthenticated) {
    return redirect("/assets");
  }

  /**
   * An address that must use SSO is sent no code, and the send answers as if
   * it were. This page tells everyone on an SSO domain where to go instead. It
   * depends only on the domain, so it says nothing about any one account.
   */
  const email = searchParams.get("email") ?? "";
  const ssoDomainHint = validEmail(email)
    ? await isSsoDomainEmail(email).catch(() => false)
    : false;

  return payload({ title, ssoDomainHint });
}

const OtpSchema = z.object({
  otp: z.string().min(2, "Please enter the code sent to your email"),
  email: z
    .string()
    .transform((email) => email.toLowerCase())
    .refine(validEmail, () => ({
      message: "Please enter a valid email",
    })),
});

export async function action({ context, request }: ActionFunctionArgs) {
  try {
    const method = getActionMethod(request);

    switch (method) {
      case "POST": {
        let formData: FormData;
        try {
          formData = await request.formData();
        } catch (cause) {
          return data(
            error(
              new ShelfError({
                cause,
                message: "Invalid request body",
                label: "Request validation",
                shouldBeCaptured: false,
                status: 400,
              }),
              false
            ),
            { status: 400 }
          );
        }

        const { email, otp } = parseData(formData, OtpSchema, {
          shouldBeCaptured: false,
        });

        const verifiedAuthSession = await verifyOtpAndSignin(email, otp);
        const { signupProfile, ...authSession } = verifiedAuthSession;
        // Whether this person already has an account is decided by the
        // authenticated id, never by the address typed: the same person can
        // type it with different capitals, and each spelling must reach the
        // same account instead of creating another.
        const existingUser = await findUserById(authSession.userId);
        const userExists = Boolean(existingUser);

        // A login is not an initialization attempt. Only a verified signup
        // that creates a Shelf user may claim the first-Team bootstrap slot.
        const isLogin =
          new URL(request.url).searchParams.get("mode") === "login";

        // What the signup link asked for, carried by cookie. A new account
        // records it on its signup event; legacy Shelf onboarding can still
        // store and act on it. A login is not a signup: the form
        // posts back to this page's URL, so `mode` is on the request, and a
        // login ignores whatever intent an earlier `/join` visit left behind.
        const signupIntent = isLogin ? null : await readSignupIntent(request);

        let isIoioSignup = false;
        if (!userExists) {
          try {
            const username = await generateUniqueUsername(authSession.email);
            const firstName = signupProfile?.firstName;
            const lastName = signupProfile?.lastName;
            isIoioSignup = Boolean(firstName && lastName);
            // Detect the caller's date/time/week/timezone prefs from browser
            // hints (accept-language + CH-time-zone cookie) and stamp them on
            // the new row. timeZone is left null when the cookie hasn't
            // round-tripped yet (see detectFormatPrefsForPersistence), so the
            // lazy backfill fills the real zone on a later load — never the
            // "UTC" fallback, which would stick forever.
            const formatPrefs = detectFormatPrefsForPersistence(request);
            await createUser({
              ...authSession,
              username,
              firstName,
              lastName,
              formatPrefs,
              signupIntent,
              bootstrapIoioTeamOnFreshSignup: !isLogin,
              ioioSignup: Boolean(firstName && lastName),
            });
          } catch (createError) {
            // Two sign-ins for the same person can run at once: if the other
            // one created the account first, carry on with it.
            const userNowExists = Boolean(
              await findUserById(authSession.userId)
            );
            if (!userNowExists) {
              throw createError;
            }
          }
        }

        // OTP completion is the recovery boundary for an existing account
        // left behind before IOIO Team initialization was introduced. Signup
        // already tried inside createUser's transaction; this idempotent call
        // also covers recovery and a concurrent duplicate-account path.
        const initializedTeam = await ensureInitialIoioTeamForUser({
          userId: authSession.userId,
        });

        // Setting the auth session and redirecting user to assets page
        context.setSession(authSession);

        const selected = await getSelectedOrganization({
          userId: authSession.userId,
          request,
        });

        // The link's `redirectTo` is followed only by an account that has
        // already onboarded. Legacy Shelf signups land on `/assets`, whose
        // layout sends them to onboarding. Complete IOIO signups resolve their
        // Team role below and continue directly into Staff Desk or Student.
        let organizationId = selected.organizationId;
        let landing = existingUser?.onboarded
          ? safeRedirect(signupIntent?.redirectTo, "/assets")
          : "/assets";

        if (isLogin || initializedTeam || isIoioSignup) {
          if (selected.noVisibleOrganizations) {
            landing = "/sso-pending-assignment";
            organizationId = "";
          } else {
            const membership = resolveIoioAccountMembership(
              selected.userOrganizations,
              selected.organizationId,
              selected.currentOrganization.type,
              selected.userOrganizations?.[0]?.user?.lastSelectedOrganizationId
            );

            if (!membership) {
              throw new ShelfError({
                cause: null,
                title: "IOIO Team organization required",
                message:
                  "Your account must belong to one authorized IOIO Team workspace. Please contact IOIO Staff to resolve workspace access.",
                status: 403,
                label: "Organization",
                shouldBeCaptured: false,
              });
            }

            organizationId = membership.organizationId;
            landing =
              resolveIoioAccountDestination(membership.roles) ?? "/assets";
          }
        }

        return redirect(landing, {
          headers: [
            ...(organizationId
              ? [
                  setCookie(
                    await setSelectedOrganizationIdCookie(organizationId)
                  ),
                ]
              : []),
            ...(await signupIntentHeaders(signupIntent)),
          ],
        });
      }
    }

    throw notAllowedMethod(method);
  } catch (cause) {
    const reason = makeShelfError(cause);
    return data(error(reason), { status: reason.status });
  }
}

export const meta: MetaFunction<typeof loader> = ({ data }) => [
  { title: data ? appendToMetaTitle(data.title) : "" },
];

type resendAction = typeof resendOtpAction;

export default function OtpPage() {
  const [message, setMessage] = useState<{
    message: string;
    type: "success" | "error";
  }>();
  const data = useActionData<typeof action>();
  const { ssoDomainHint } = useLoaderData<typeof loader>();
  const [searchParams] = useSearchParams();
  const fetcher = useFetcher<resendAction>();

  const formRef = useRef<HTMLFormElement>(null);
  const zo = useZorm("otpForm", OtpSchema);
  const zormRef = useCallback(
    (el: HTMLFormElement | null) => {
      zo.ref(el);
      formRef.current = el;
    },
    [zo]
  );
  const fetcherDisabled = isFormProcessing(fetcher.state);
  const disabled = useDisabled();

  const email = searchParams.get("email") || "";
  const mode = searchParams.get("mode") as OtpVerifyMode;
  const pageData = getOtpPageData(mode);

  function handleResendOtp() {
    const formData = new FormData();
    formData.append("email", email);
    formData.append("mode", mode);

    try {
      void fetcher.submit(formData, {
        method: "POST",
        action: "/resend-otp",
      });
    } catch {
      setMessage({
        message: "Something went wrong. Please try again.",
        type: "error",
      });
    }
  }

  /** Handle success and error state when resending with fetcher */
  useEffect(() => {
    if (fetcher?.data) {
      if (fetcher.data.error) {
        setMessage({
          message: fetcher.data.error.message,
          type: "error",
        });
      } else {
        setMessage({
          message: "Email sent successfully. Please check your inbox.",
          type: "success",
        });
      }
    }
  }, [fetcher]);

  return (
    <>
      <pageData.SubHeading email={email} />

      <div className="mt-2 flex min-h-full flex-col justify-center">
        <div className="mx-auto w-full max-w-md px-8">
          <Form ref={zormRef} method="post" className="space-y-6">
            <ShelfOTP
              error={data?.error.message}
              onComplete={() => formRef.current?.requestSubmit()}
            />

            <input
              type="hidden"
              name="email"
              value={searchParams.get("email") || ""}
            />

            {ssoDomainHint ? (
              <p className="text-sm text-gray-600">
                If your organization uses single sign-on, you may not receive a
                code. Use{" "}
                <Button variant="link" to="/sso-login">
                  Login with SSO
                </Button>{" "}
                instead.
              </p>
            ) : null}

            {message?.message && (
              <p
                className={tw(
                  " text-sm",
                  message.type === "error"
                    ? "text-error-500"
                    : "text-success-500"
                )}
              >
                {message.message}
              </p>
            )}

            <IoioAuthPrimaryButton
              data-test-id="create-account"
              type="submit"
              disabled={fetcherDisabled || disabled}
            >
              {pageData.buttonTitle}
            </IoioAuthPrimaryButton>
          </Form>

          <button
            className="mt-6 w-full text-center text-sm font-semibold"
            onClick={handleResendOtp}
          >
            Didn&apos;t receive the email?{" "}
            <span className="text-primary-500">
              {fetcherDisabled ? "Sending..." : "Resend it"}
            </span>
          </button>
        </div>
      </div>
    </>
  );
}
