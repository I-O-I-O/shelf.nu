// @vitest-environment node
import * as Sentry from "@sentry/react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ShelfError } from "./error";
import { Logger, logMissingFormIntent } from "./logger";

// why: handledClientError emits to Sentry's structured-log API; capture the
// calls instead of hitting the network. captureException is stubbed too because
// Logger.error uses it.
vi.mock("@sentry/react-router", () => ({
  captureException: vi.fn(),
  logger: { info: vi.fn() },
}));

// why: handledClientError early-returns unless a SENTRY_DSN is configured, and
// the module also reads `env`; provide both so the emit path is exercised.
vi.mock("./env", () => ({
  SENTRY_DSN: "https://test@example.ingest.sentry.io/1",
  env: { NODE_ENV: "test" },
}));

const make4xx = (overrides: Record<string, unknown> = {}) =>
  new ShelfError({
    cause: null,
    message: "Please select a date in the future",
    label: "Request validation",
    status: 400,
    ...overrides,
  });

describe("Logger.handledClientError", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("emits a low-severity Sentry log for a 4xx ShelfError", () => {
    Logger.handledClientError(make4xx());

    expect(Sentry.logger.info).toHaveBeenCalledWith(
      "Please select a date in the future",
      expect.objectContaining({ status: 400, label: "Request validation" })
    );
  });

  it("does not emit for a 5xx ShelfError (server fault stays an error event)", () => {
    Logger.handledClientError(make4xx({ status: 500 }));
    expect(Sentry.logger.info).not.toHaveBeenCalled();
  });

  it("attaches the userId when present", () => {
    Logger.handledClientError(
      make4xx({ additionalData: { userId: "real-user-1" } })
    );
    expect(Sentry.logger.info).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ userId: "real-user-1" })
    );
  });
});

describe("logMissingFormIntent", () => {
  it("redacts credential headers, URL parameters, and form values", () => {
    const formData = new FormData();
    formData.set("password", "private-password");
    formData.set("otp", "private-otp");
    formData.set("comment", "keep this diagnostic");

    const request = new Request(
      "https://app.shelf.nu/bookings/booking-1?token=private-query-token",
      {
        method: "POST",
        headers: {
          authorization: "Bearer private-header-token",
          cookie: "__authSession=private-cookie",
          "x-api-key": "private-api-key",
          "content-type": "application/x-www-form-urlencoded",
          "user-agent": "private-device-fingerprint",
          "x-forwarded-for": "203.0.113.44",
        },
      }
    );

    logMissingFormIntent({
      formData,
      request,
      bookingId: "booking-1",
      userId: "user-1",
    });

    const logged = JSON.stringify(
      vi.mocked(Sentry.captureException).mock.calls
    );
    expect(logged).not.toMatch(
      /private-(?:password|otp|query-token|header-token|cookie|api-key)/
    );
    expect(logged).not.toContain("keep this diagnostic");
    expect(logged).not.toContain("private-device-fingerprint");
    expect(logged).not.toContain("203.0.113.44");
    expect(logged).not.toContain("private-query-token");
    expect(logged).toContain("application/x-www-form-urlencoded");
    expect(logged).toContain('"formKeys":["password","otp","comment"]');
    const captured = vi.mocked(Sentry.captureException).mock.calls[0]?.[0] as {
      additionalData?: { requestUrl?: string };
    };
    expect(captured.additionalData?.requestUrl).toBe("/bookings/booking-1");
  });
});
