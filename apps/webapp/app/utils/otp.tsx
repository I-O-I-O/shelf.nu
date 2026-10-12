import type { FC } from "react";
import SubHeading from "~/components/shared/sub-heading";

export type OtpVerifyMode = "login" | "signup" | "confirm_signup";

export type OtpPageData = Record<
  OtpVerifyMode,
  {
    title: string;
    SubHeading: FC<{ email: string }>;
    buttonTitle: string;
  }
>;

export const OTP_PAGE_MAP: OtpPageData = {
  login: {
    title: "Check your email",
    SubHeading: ({ email }) => (
      <SubHeading className="-mt-4 text-center">
        We sent a sign-in code to{" "}
        <span className="font-bold text-gray-900">{email}</span>. Fill the code
        below to log in.
      </SubHeading>
    ),
    buttonTitle: "Log in",
  },
  signup: {
    title: "Check your email",
    SubHeading: () => (
      <SubHeading className="-mt-4 text-center">
        Follow the verification instructions in your email to continue.
      </SubHeading>
    ),
    buttonTitle: "Verify email",
  },
  confirm_signup: {
    title: "Check your email",
    SubHeading: ({ email }) => (
      <SubHeading className="-mt-4 text-center">
        We sent a verification code to{" "}
        <span className="font-bold text-gray-900">{email}</span>. Enter it below
        to verify your email and continue.
      </SubHeading>
    ),
    buttonTitle: "Verify email",
  },
};

export const DEFAULT_PAGE_DATA: OtpPageData["login"] = {
  title: "Check your email",
  buttonTitle: "Continue",
  SubHeading: () => (
    <SubHeading className="-mt-4 text-center">
      Follow the instructions in your email to continue.
    </SubHeading>
  ),
};

export function getOtpPageData(mode: OtpVerifyMode) {
  return OTP_PAGE_MAP[mode] ?? DEFAULT_PAGE_DATA;
}
