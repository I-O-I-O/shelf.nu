import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import { data, redirect, useActionData, useNavigation } from "react-router";

import { useZorm } from "react-zorm";
import { z } from "zod";
import { Form } from "~/components/custom-form";

import Input from "~/components/forms/input";
import { Button } from "~/components/shared/button";
import { useSearchParams } from "~/hooks/search-params";
import { useAutoFocus } from "~/hooks/use-auto-focus";
import {
  INVALID_CREDENTIALS_MESSAGE,
  signInWithEmail,
} from "~/modules/auth/service.server";
import { isSsoDomainEmail } from "~/modules/auth/sso-enforcement.server";

import {
  getSelectedOrganization,
  setSelectedOrganizationIdCookie,
} from "~/modules/organization/context.server";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import { setCookie } from "~/utils/cookies.server";
import {
  ShelfError,
  isLikeShelfError,
  isZodValidationError,
  makeShelfError,
  notAllowedMethod,
} from "~/utils/error";
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

async function getAuthenticatedLanding({
  userId,
  request,
  requestedDestination,
}: {
  userId: string;
  request: Request;
  requestedDestination?: string | null;
}) {
  const selected = await getSelectedOrganization({ userId, request });
  if (selected.noVisibleOrganizations) {
    return {
      destination: "/sso-pending-assignment",
      organizationId: null,
    };
  }

  const membership = resolveIoioAccountMembership(
    selected.userOrganizations,
    selected.organizationId,
    selected.currentOrganization.type
  );
  const organizationId = membership?.organizationId ?? selected.organizationId;
  const roles = membership?.roles;
  const defaultDestination = resolveIoioAccountDestination(roles);
  if (!defaultDestination) {
    throw new ShelfError({
      cause: null,
      title: "Account role could not be resolved",
      message: "Your account role could not be verified. Please contact Staff.",
      status: 403,
      label: "Permission",
      shouldBeCaptured: false,
    });
  }

  const safeDestination = safeRedirect(
    requestedDestination || defaultDestination,
    defaultDestination
  );

  return {
    destination:
      resolveIoioAccountDestination(roles, safeDestination) ??
      defaultDestination,
    organizationId,
  };
}

export async function loader({ context, request }: LoaderFunctionArgs) {
  const title = "Welcome back";

  if (context.isAuthenticated) {
    const { userId } = context.getSession();
    const landing = await getAuthenticatedLanding({
      userId,
      request,
      requestedDestination: new URL(request.url).searchParams.get("redirectTo"),
    });
    const headers = landing.organizationId
      ? [
          setCookie(
            await setSelectedOrganizationIdCookie(landing.organizationId)
          ),
        ]
      : [];
    return redirect(landing.destination, { headers });
  }

  return data(payload({ title }));
}

const LoginFormSchema = z.object({
  email: z
    .string()
    .transform((email) => email.toLowerCase())
    .refine(validEmail, () => ({
      message: "Please enter a valid email",
    })),
  password: z.string().min(8, "Password is too short. Minimum 8 characters."),
  redirectTo: z.string().optional(),
});

export async function action({ context, request }: ActionFunctionArgs) {
  /**
   * Set when a wrong email/password pair was typed for an address on a domain
   * configured for SSO. It depends only on the domain, never on the account, so
   * it is the same for every address on that domain whether or not it exists.
   */
  let ssoDomainHint = false;

  try {
    const method = getActionMethod(request);

    switch (method) {
      case "POST": {
        // Guard against bots sending non-form content types
        const contentType = request.headers.get("content-type") || "";
        if (
          !contentType.includes("application/x-www-form-urlencoded") &&
          !contentType.includes("multipart/form-data")
        ) {
          return data(
            error(
              new ShelfError({
                cause: null,
                message: "Invalid request",
                label: "Request validation",
                shouldBeCaptured: false,
                status: 400,
              }),
              false
            ),
            { status: 400 }
          );
        }

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

        const { email, password, redirectTo } = parseData(
          formData,
          LoginFormSchema,
          { shouldBeCaptured: false }
        );

        let authSession: Awaited<ReturnType<typeof signInWithEmail>>;
        try {
          authSession = await signInWithEmail(email, password);
        } catch (cause) {
          if (
            isLikeShelfError(cause) &&
            cause.message === INVALID_CREDENTIALS_MESSAGE
          ) {
            // The hint is a courtesy: a failed domain lookup must not replace
            // the sign-in error the person actually needs to see.
            ssoDomainHint = await isSsoDomainEmail(email).catch(() => false);
          }
          throw cause;
        }

        if (!authSession) {
          return redirect(`/otp?email=${encodeURIComponent(email)}&mode=login`);
        }
        const { userId } = authSession;

        /**
         * The only reason we need to do this is because of the initial login
         * Theoretically, the user should always have a selected organization cookie as soon as they login for the first time
         * However we do this check to make sure they are still part of that organization
         */
        const landing = await getAuthenticatedLanding({
          userId,
          request,
          requestedDestination: redirectTo,
        });

        // Set the Shelf session, retain the selected-workspace cookie, and
        // land on the authenticated IOIO surface for this membership.
        context.setSession(authSession);

        const headers = landing.organizationId
          ? [
              setCookie(
                await setSelectedOrganizationIdCookie(landing.organizationId)
              ),
            ]
          : [];
        return redirect(landing.destination, { headers });
      }
    }

    throw notAllowedMethod(method);
  } catch (cause) {
    const reason = makeShelfError(
      cause,
      undefined,
      isLikeShelfError(cause)
        ? cause.shouldBeCaptured
        : !isZodValidationError(cause)
    );
    return data({ ...error(reason), ssoDomainHint }, { status: reason.status });
  }
}

export const meta: MetaFunction<typeof loader> = ({ data }) => [
  { title: data ? appendToMetaTitle(data.title) : "" },
];

export default function IndexLoginForm() {
  const zo = useZorm("NewQuestionWizardScreen", LoginFormSchema);
  const [searchParams] = useSearchParams();
  const redirectTo = searchParams.get("redirectTo") ?? undefined;
  const acceptedInvite = searchParams.get("acceptedInvite");
  const passwordReset = searchParams.get("password_reset");
  const data = useActionData<typeof action>();

  const navigation = useNavigation();
  const disabled = isFormProcessing(navigation.state);

  /** Focus the email field on mount (intentional first-field focus on auth pages). */
  const emailInputRef = useAutoFocus<HTMLInputElement>();

  return (
    <div className="w-full max-w-md">
      {acceptedInvite ? (
        <div className="mb-8 text-center text-success-600">
          Successfully accepted workspace invite. Please login to see your new
          workspace.
        </div>
      ) : null}

      {passwordReset ? (
        <div className="mb-8 text-center text-success-600">
          You have successfully reset your password. You can now use your new
          password to login.
        </div>
      ) : null}
      <Form ref={zo.ref} method="post" replace className="flex flex-col gap-5">
        <div>
          <Input
            ref={emailInputRef}
            data-test-id="email"
            label="Email"
            placeholder="you@example.com"
            required
            name={zo.fields.email()}
            type="email"
            autoComplete="username"
            disabled={disabled}
            inputClassName="w-full rounded-xl shadow-none focus:border-red-600 focus:ring-2 focus:ring-red-600"
            error={zo.errors.email()?.message || data?.error.message}
          />
        </div>
        <Input
          label="Password"
          placeholder="Enter your password"
          data-test-id="password"
          name={zo.fields.password()}
          type="password"
          autoComplete="current-password"
          disabled={disabled}
          inputClassName="w-full rounded-xl shadow-none focus:border-red-600 focus:ring-2 focus:ring-red-600"
          error={zo.errors.password()?.message || data?.error.message}
        />
        <input type="hidden" name={zo.fields.redirectTo()} value={redirectTo} />
        <Button
          className="min-h-11 w-full rounded-xl border-red-700 bg-red-700 text-center text-white focus:ring-2 focus:ring-red-600 enabled:hover:border-red-800 enabled:hover:bg-red-800 disabled:border-red-300 disabled:bg-red-300"
          type="submit"
          data-test-id="login"
          disabled={disabled}
        >
          {disabled ? "Logging in..." : "Log in"}
        </Button>
      </Form>
      <div className="mt-5 text-center text-sm text-gray-500">
        <Button
          variant="link"
          className="text-red-700 hover:text-red-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-600 focus-visible:ring-offset-2"
          to={{
            pathname: "/forgot-password",
            search: searchParams.toString(),
          }}
        >
          Forgot password?
        </Button>
      </div>
    </div>
  );
}
