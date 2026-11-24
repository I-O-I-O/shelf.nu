import { describe, expect, it } from "vitest";

import { scrubRequestTelemetry } from "./request-telemetry";

describe("scrubRequestTelemetry", () => {
  it("redacts credential headers, every cookie value, and request bodies", () => {
    const event = {
      request: {
        headers: {
          authorization: "Bearer private-access-token",
          cookie: "__authSession=private-session-cookie",
          "x-api-key": "private-api-key",
          "content-type": "application/json",
        },
        cookies: {
          __authSession: "private-session-cookie",
          preference: "dark",
        },
        url: "https://app.shelf.nu/login?access_token=private-url-token&token_hash=private-reset-link&token=private-invite-token&next=%2Fassets",
        query_string:
          "access_token=private-query-token&token_hash=private-reset-link&token=private-invite-token&next=%2Fassets",
        data: { email: "student@example.edu", password: "private-password" },
      },
      extra: {
        diagnostic: { refreshToken: "private-extra-token", step: "callback" },
      },
    };

    expect(scrubRequestTelemetry(event)).toEqual({
      request: {
        headers: {
          authorization: "[REDACTED]",
          cookie: "[REDACTED]",
          "x-api-key": "[REDACTED]",
          "content-type": "application/json",
        },
        cookies: {
          __authSession: "[REDACTED]",
          preference: "[REDACTED]",
        },
        url: "https://app.shelf.nu/login?access_token=REDACTED&token_hash=REDACTED&token=REDACTED&next=%2Fassets",
        query_string:
          "access_token=REDACTED&token_hash=REDACTED&token=REDACTED&next=%2Fassets",
        data: "[REDACTED]",
      },
      extra: {
        diagnostic: { refreshToken: "[REDACTED]", step: "callback" },
      },
    });
    expect(JSON.stringify(scrubRequestTelemetry(event))).not.toMatch(
      /private-(?:access-token|session-cookie|api-key|password|url-token|query-token|extra-token|reset-link|invite-token)/
    );
  });

  it("leaves events without request metadata unchanged", () => {
    const event = { message: "safe diagnostic" };
    expect(scrubRequestTelemetry(event)).toBe(event);
  });
});
