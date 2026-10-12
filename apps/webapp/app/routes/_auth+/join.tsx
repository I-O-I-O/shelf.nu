import type {
  LoaderFunctionArgs,
  ActionFunctionArgs,
  MetaFunction,
} from "react-router";
import {
  redirect,
  data,
  useActionData,
  useLoaderData,
  useNavigation,
} from "react-router";

import { useZorm } from "react-zorm";
import { z } from "zod";
import { Form } from "~/components/custom-form";

import Input from "~/components/forms/input";
import PasswordInput from "~/components/forms/password-input";
import { IoioAuthPrimaryButton } from "~/components/ioio/auth-primary-button";
import { Button } from "~/components/shared/button";
import { config } from "~/config/shelf.config";
import { useSearchParams } from "~/hooks/search-params";
import { useAutoFocus } from "~/hooks/use-auto-focus";
import { signUpWithEmailPass } from "~/modules/auth/service.server";
import {
  clearSignupIntentHeaders,
  readSignupIntent,
  refreshSignupIntentHeaders,
  signupIntentHeaders,
} from "~/modules/signup-intent/cookie.server";
import {
  parseSignupIntentFromSearchParams,
  signupIntentNotice,
} from "~/modules/signup-intent/schema";
import { findUserByEmail } from "~/modules/user/service.server";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import {
  ShelfError,
  isZodValidationError,
  makeShelfError,
  notAllowedMethod,
} from "~/utils/error";
import { isFormProcessing } from "~/utils/form";
import { getValidationErrors } from "~/utils/http";
import {
  payload,
  error,
  getActionMethod,
  getCurrentSearchParams,
  parseData,
} from "~/utils/http.server";
import { validEmail } from "~/utils/misc";
import { validateNonSSOSignup } from "~/utils/sso.server";
import { passwordSchema } from "~/utils/zod";

export async function loader({ context, request }: LoaderFunctionArgs) {
  const title = "Create an account";
  const subHeading = "Create your IOIO account";
  const { disableSignup } = config;

  try {
    if (disableSignup) {
      throw new ShelfError({
        cause: null,
        title: "Signup is disabled",
        message:
          "For more information, please contact your workspace administrator.",
        label: "User onboarding",
        status: 403,
        shouldBeCaptured: false,
      });
    }
    if (context.isAuthenticated) {
      return redirect("/assets");
    }

    // What the signup link asked for (`?plan=team&trial=true&utm_*=…`). From
    // here on it travels in a signed cookie, so both signup paths and the
    // email-code confirmation carry it into the IOIO destination or Shelf
    // onboarding when that flow still applies. The page itself only uses it
    // for the confirmation line under the heading.
    const signupIntent = parseSignupIntentFromSearchParams(
      getCurrentSearchParams(request)
    );

    // A visit without intent parameters starts a signup of its own, so it
    // drops any intent an earlier visit on this browser left behind. Every
    // in-app link back to `/join` forwards the query string, so a signup in
    // progress never lands here without its parameters.
    let headers: Array<[string, string]> = [];
    if (signupIntent) {
      headers = await signupIntentHeaders(signupIntent);
    } else if (await readSignupIntent(request)) {
      headers = await clearSignupIntentHeaders();
    }

    return data(payload({ title, subHeading, signupIntent }), { headers });
  } catch (cause) {
    const reason = makeShelfError(cause);
    throw data(error(reason), { status: reason.status });
  }
}

const JoinFormSchema = z
  .object({
    firstName: z.string().trim().min(1, "First name is required"),
    lastName: z.string().trim().min(1, "Last name is required"),
    email: z
      .string()
      .transform((email) => email.toLowerCase())
      .refine(validEmail, () => ({
        message: "Please enter a valid email",
      })),
    password: passwordSchema(),
    confirmPassword: passwordSchema(),
    redirectTo: z.string().optional(),
  })
  .superRefine(({ password, confirmPassword }, ctx) => {
    if (password !== confirmPassword) {
      return ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Password and confirm password must match",
        path: ["confirmPassword"],
      });
    }
  });

export async function action({ request }: ActionFunctionArgs) {
  try {
    const method = getActionMethod(request);

    switch (getActionMethod(request)) {
      case "POST": {
        const { firstName, lastName, email, password } = parseData(
          await request.formData(),
          JoinFormSchema,
          { shouldBeCaptured: false }
        );
        // Block signup if domain uses SSO
        await validateNonSSOSignup(email);

        const existingUser = await findUserByEmail(email);

        if (existingUser) {
          throw new ShelfError({
            cause: null,
            message: "User with this Email already exits, login instead",
            additionalData: {
              email,
            },
            label: "User onboarding",
            shouldBeCaptured: false,
            status: 409,
          });
        }

        // Sign up with the provided email and password
        await signUpWithEmailPass(email, password, { firstName, lastName });

        return redirect(
          `/otp?email=${encodeURIComponent(email)}&mode=confirm_signup`,
          {
            // Re-issue the signup link's intent so its window restarts here
            // rather than at the first page view.
            headers: await refreshSignupIntentHeaders(request),
          }
        );
      }
    }

    throw notAllowedMethod(method);
  } catch (cause) {
    const reason = makeShelfError(
      cause,
      undefined,
      isZodValidationError(cause)
    );
    return data(error(reason), { status: reason.status });
  }
}

export const meta: MetaFunction<typeof loader> = ({ data }) => [
  { title: data ? appendToMetaTitle(data.title) : "" },
];

export default function Join() {
  const { signupIntent } = useLoaderData<typeof loader>();
  const zo = useZorm("NewQuestionWizardScreen", JoinFormSchema);
  const [searchParams] = useSearchParams();
  const redirectTo = searchParams.get("redirectTo") ?? undefined;
  const navigation = useNavigation();
  const disabled = isFormProcessing(navigation.state);
  const data = useActionData<typeof action>();

  /** Focus the first field on mount (intentional first-field focus on auth pages). */
  const firstNameInputRef = useAutoFocus<HTMLInputElement>();

  const intentNotice = signupIntentNotice({
    intent: signupIntent,
    freeTrialDays: config.freeTrialDays,
  });

  return (
    <div className="flex min-h-full flex-col justify-center">
      <div className="mx-auto w-full max-w-md">
        {intentNotice ? (
          <p
            className="mb-6 text-center text-sm text-gray-600"
            data-test-id="signup-intent-notice"
          >
            {intentNotice}
          </p>
        ) : null}
        <Form ref={zo.ref} method="post" className="space-y-6" replace>
          <div className="flex flex-col gap-5 sm:flex-row">
            <Input
              ref={firstNameInputRef}
              data-test-id="firstName"
              label="First name"
              placeholder="First name"
              required
              name={zo.fields.firstName()}
              type="text"
              autoComplete="given-name"
              disabled={disabled}
              inputClassName="w-full rounded-xl shadow-none focus:border-red-600 focus:ring-2 focus:ring-red-600"
              error={zo.errors.firstName()?.message}
            />
            <Input
              data-test-id="lastName"
              label="Last name"
              placeholder="Last name"
              required
              name={zo.fields.lastName()}
              type="text"
              autoComplete="family-name"
              disabled={disabled}
              inputClassName="w-full rounded-xl shadow-none focus:border-red-600 focus:ring-2 focus:ring-red-600"
              error={zo.errors.lastName()?.message}
            />
          </div>
          <div>
            <Input
              data-test-id="email"
              label="Email address"
              placeholder="student@example.com"
              required
              name={zo.fields.email()}
              type="email"
              autoComplete="email"
              disabled={disabled}
              inputClassName="w-full rounded-xl shadow-none focus:border-red-600 focus:ring-2 focus:ring-red-600"
              error={zo.errors.email()?.message || data?.error.message}
            />
          </div>

          <PasswordInput
            label="Password"
            placeholder="**********"
            required
            data-test-id="password"
            name={zo.fields.password()}
            autoComplete="new-password"
            disabled={disabled}
            inputClassName="w-full rounded-xl shadow-none focus:border-red-600 focus:ring-2 focus:ring-red-600"
            error={
              getValidationErrors<typeof JoinFormSchema>(data?.error)?.password
                ?.message || zo.errors.password()?.message
            }
          />
          <PasswordInput
            label="Confirm Password"
            placeholder="**********"
            required
            data-test-id="confirmPassword"
            name={zo.fields.confirmPassword()}
            autoComplete="new-password"
            disabled={disabled}
            inputClassName="w-full rounded-xl shadow-none focus:border-red-600 focus:ring-2 focus:ring-red-600"
            error={
              getValidationErrors<typeof JoinFormSchema>(data?.error)
                ?.confirmPassword?.message ||
              zo.errors.confirmPassword()?.message
            }
          />

          <input
            type="hidden"
            name={zo.fields.redirectTo()}
            value={redirectTo}
          />
          <IoioAuthPrimaryButton
            type="submit"
            data-test-id="create-account"
            disabled={disabled}
          >
            {disabled ? "Creating account..." : "Create account"}
          </IoioAuthPrimaryButton>
        </Form>
        <div className="flex items-center justify-center pt-5">
          <div className="text-center text-sm text-gray-500">
            {"Already have an account? "}
            <Button
              variant="link"
              className="font-semibold text-red-700 hover:text-red-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-600 focus-visible:ring-offset-2"
              to={{
                pathname: "/",
                search: searchParams.toString(),
              }}
            >
              Log in
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
