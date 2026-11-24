import type { CSSProperties } from "react";
import {
  Button,
  Container,
  Head,
  Html,
  render,
  Text,
} from "@react-email/components";
import { styles } from "./styles";

export function passwordResetTextEmail({
  resetUrl,
  otp,
}: {
  resetUrl: string;
  otp: string;
}) {
  return `A request was made to reset your Shelf password.\n\nUse this secure link to choose a new password:\n${resetUrl}\n\nYou can also enter this one-time code on the password reset page: ${otp}\n\nIf you did not request a password reset, you can ignore this email. Do not share this link or code with anyone.`;
}

function PasswordResetHtmlEmail({
  resetUrl,
  otp,
}: {
  resetUrl: string;
  otp: string;
}) {
  return (
    <Html>
      <Head>
        <title>Reset your Shelf password</title>
      </Head>
      <Container style={{ maxWidth: "100%" }}>
        <Text style={styles.p}>
          A request was made to reset your Shelf password.
        </Text>
        <Button href={resetUrl} style={styles.button as CSSProperties}>
          Reset password
        </Button>
        <Text style={styles.p}>
          You can also enter this one-time code on the password reset page:{" "}
          <b>{otp}</b>
        </Text>
        <Text style={styles.p}>
          If you did not request a password reset, you can ignore this email. Do
          not share this link or code with anyone.
        </Text>
      </Container>
    </Html>
  );
}

export function passwordResetHtmlEmail({
  resetUrl,
  otp,
}: {
  resetUrl: string;
  otp: string;
}) {
  return render(<PasswordResetHtmlEmail resetUrl={resetUrl} otp={otp} />);
}
