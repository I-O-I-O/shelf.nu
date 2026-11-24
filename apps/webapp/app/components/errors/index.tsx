import type { ReactNode } from "react";
import { Component, lazy, Suspense, useEffect, useState } from "react";
import * as Sentry from "@sentry/react-router";
import { isRouteErrorResponse, useLocation, useRouteError } from "react-router";

import { StaffLogo } from "~/components/ioio-staff/staff-logo";
import { IOIO_BRAND_NAME } from "~/config/ioio-brand";
import { useUserData } from "~/hooks/use-user-data";
import { isRouteError } from "~/utils/http";
import { isExpectedErrorBoundaryStatus } from "~/utils/sentry-filters";
import { tw } from "~/utils/tw";
import Error404Handler from "./error-404-handler";
import { parse404ErrorData } from "./utils";
import { Button } from "../shared/button";

/* Lazy: root.tsx uses ErrorContent as the app-wide ErrorBoundary, so a
 * static import would pull the feedback modal (crisp-sdk-web, react-zorm,
 * the dialog) into the root chunk shipped to every visitor. The chunk only
 * loads when someone actually clicks "Report this issue". */
const FeedbackModal = lazy(() => import("../feedback/feedback-modal"));

/**
 * Catches a failed lazy-chunk load (or render crash) of the feedback modal.
 * ErrorContent already IS the app-wide error boundary, so anything escaping
 * from here would blank the whole error page; failing to load the report
 * dialog should degrade to hiding the report UI instead.
 */
class ReportModalBoundary extends Component<
  { onError: () => void; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch() {
    this.props.onError();
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

type ErrorContentProps = { className?: string };

export const IOIO_ERROR_COPY = {
  unexpected:
    "We couldn't load this page right now. Try again, or contact IOIO staff if the problem continues.",
  notFound: "We couldn't find the page you're looking for.",
  rateLimit:
    "You're doing that a bit too quickly. Please wait a moment, then try again.",
};

export function BackToIoioButton({ to }: { to: string }) {
  return (
    <Button to={to} variant="secondary">
      Back to IOIO
    </Button>
  );
}

const IOIO_PRIMARY_BUTTON_CLASS =
  "!border-red-700 !bg-red-700 text-white focus-visible:!ring-red-700 active:!bg-red-800 enabled:hover:!bg-red-800";

export type IoioErrorScreenProps = {
  className?: string;
  title: string;
  message: string;
  actions: ReactNode;
};

/**
 * Shared standalone IOIO error screen. It is intentionally independent of
 * the staff/student shells so it can render when either shell failed.
 */
export function IoioErrorScreen({
  className,
  title,
  message,
  actions,
}: IoioErrorScreenProps) {
  return (
    <div
      className={tw(
        "flex min-h-dvh w-full items-center justify-center bg-white px-4 py-12",
        className
      )}
    >
      <div className="flex w-full max-w-xl flex-col items-center text-center">
        <div className="mb-4">
          <StaffLogo large />
        </div>
        <p className="mb-5 text-sm font-semibold tracking-wide text-gray-700">
          {IOIO_BRAND_NAME}
        </p>
        <h1 className="mb-2 text-2xl font-bold text-gray-900">{title}</h1>
        <p className="max-w-[550px] text-gray-600">{message}</p>
        <div className="mt-7 flex flex-wrap justify-center gap-3">
          {actions}
        </div>
      </div>
    </div>
  );
}

/**
 * App-wide `ErrorBoundary` content, rendered by `root.tsx` and the
 * authenticated `_layout` route for any error that reaches a route
 * boundary. Branches into three screens:
 * - The benign workspace-switcher case (`<Error404Handler/>`): the resource
 *   exists but belongs to another of the user's organizations.
 * - A genuine 404 that is NOT the workspace-switcher shape: a calm
 *   not-found screen. This includes both Shelf-thrown 404s (`{ error }`
 *   payload) and router-generated 404s for an unmatched/stale URL (a plain
 *   `Error` payload) — see `isNotFound` below.
 * - Everything else: a generic, IOIO-branded error screen.
 *
 * Also captures failures to Sentry: unhandled client-side `Error` instances
 * (JS crashes), and route-error 4xx responses that aren't already captured
 * server-side (5xx is captured server-side by `handleError`/`error()`; the
 * workspace-switcher case is expected UX, not a bug, so it's never
 * captured).
 */
export const ErrorContent = ({ className }: ErrorContentProps) => {
  const loc = useLocation();
  const response = useRouteError();

  /* Present when the authenticated app layout rendered (child-route errors).
   * That is also the only case where /api/feedback can accept a report, so
   * the "Report this issue" button is gated on it. */
  const user = useUserData();
  const [reportOpen, setReportOpen] = useState(false);
  /* Flipped when the modal chunk fails to load/render: the report UI hides
   * instead of leaving a button that blanks the page when clicked */
  const [reportBroken, setReportBroken] = useState(false);

  let reportErrorTitle: string | undefined;
  let reportErrorMessage = "An unexpected application error occurred.";
  let sentryMessage = reportErrorMessage;
  let traceId: string | undefined;
  let errorLabel: string | undefined;
  let errorStatus: string | undefined;
  let statusCode: number | undefined;

  if (isRouteErrorResponse(response)) {
    statusCode = response.status;
    errorStatus = String(response.status);
  }

  if (isRouteError(response)) {
    sentryMessage = response.data.error.message;
    reportErrorMessage = sentryMessage;
    reportErrorTitle = response.data.error.title;
    traceId = response.data.error.traceId;
    errorLabel = response.data.error.label;
  }

  /* For client-side crashes the rendered message is a generic fallback, so
   * attach the real error message to the report instead */
  if (response instanceof Error) {
    reportErrorMessage = response.message;
    sentryMessage = response.message;
  }

  const error404 = parse404ErrorData(response);

  /**
   * A genuine "resource not found": a route-error response with HTTP 404
   * that is NOT the workspace-switcher shape (that shape renders
   * `<Error404Handler/>` below with its own "switch workspace?" UX instead
   * of this calmer not-found screen).
   *
   * Gated on `isRouteErrorResponse` (router shape + status), NOT
   * `isRouteError` (Shelf payload shape): React Router itself throws a
   * 404 `ErrorResponse` for an unmatched/stale URL whose `.data` is a plain
   * `Error`, not Shelf's `{ error: {...} }` payload — `isRouteError` is
   * `false` for that case even though it is a genuine 404. `error404` above
   * already handles this safely (`parse404ErrorData` returns
   * `isError404: false` when there's no Shelf payload to parse).
   */
  const isNotFound =
    isRouteErrorResponse(response) &&
    !error404.isError404 &&
    statusCode === 404;

  /**
   * A rate-limit terminal state: the request tripped a server-side rate
   * limiter (e.g. `appLoaderRateLimit`'s per-(user, path) cap on `.data`
   * revalidations — see `server/rate-limit.ts`). This is a transient,
   * EXPECTED condition, not a bug — the boundary shows a calm "try again in
   * a moment" screen instead of the alarming generic one.
   *
   * Gated purely on `statusCode` (like `isNotFound`), NOT `isRouteError`:
   * `appLoaderRateLimit` is Hono middleware that responds with a plain
   * `c.json(...)` 429 BEFORE the request reaches Remix's single-fetch data
   * handling, so the client can't decode it into the Shelf
   * `{ error: { message, title, … } }` payload shape — `response.data` ends
   * up as a bare `Error`, the same way a router-generated 404 does (see
   * `isNotFound`'s doc comment). Relying on `isRouteError` here would miss
   * exactly the case this fix exists for.
   */
  const isRateLimited = isRouteErrorResponse(response) && statusCode === 429;

  /**
   * Route-error responses in the 4xx range (bad input, permission denials,
   * genuine not-found, …) that reach this boundary are NOT already captured
   * server-side — `error()` in http.server.ts only routes 5xx (and
   * uncaught errors) to Sentry via `Logger.error`; handled 4xx land on the
   * low-severity log trail instead. Capture them here so they're findable
   * by their trace id in internal reports. 5xx is excluded (already
   * captured server-side — capturing again here would double-report), and
   * the benign workspace-switcher case is excluded entirely (expected
   * cross-org UX, not a bug).
   *
   * EXPECTED terminal states (403 permission-denied / expired claim, 404
   * not-found, 429 rate-limited — see `EXPECTED_ERROR_BOUNDARY_STATUSES`)
   * are also excluded: they are normal UX, not bugs, so they must not open a
   * Sentry issue. All other 4xx (400/409/422, …) stay captured. `beforeSend`
   * re-checks the `status` tag as defense-in-depth, but this is the primary
   * skip — the intent is clearest where the status is a number in hand.
   *
   * Gated on `isRouteErrorResponse` (see `isNotFound` above for why) so
   * router-generated 4xx responses (e.g. an unmatched-route 404) are
   * captured too, even though they carry no Shelf payload.
   */
  const shouldCaptureRouteError =
    isRouteErrorResponse(response) &&
    !error404.isError404 &&
    statusCode !== undefined &&
    statusCode >= 400 &&
    statusCode < 500 &&
    !isExpectedErrorBoundaryStatus(statusCode);

  /**
   * Public not-found copy is deliberately static; Shelf's error payload may
   * contain resource identifiers or internal route details.
   */
  const notFoundMessage = IOIO_ERROR_COPY.notFound;

  /** Keep rate-limit copy fixed so internal error payloads stay hidden. */
  const rateLimitMessage = IOIO_ERROR_COPY.rateLimit;

  const errorPageTitle = isNotFound
    ? "Page not found"
    : error404.isError404
    ? "Page not found"
    : isRateLimited
    ? "Please wait a moment"
    : "Something went wrong";

  useEffect(() => {
    document.title = `${errorPageTitle} · ${IOIO_BRAND_NAME}`;
  }, [errorPageTitle]);

  // Capture unhandled Error instances (client-side crashes) client-side,
  // and capturable 4xx route errors (see shouldCaptureRouteError above).
  // Route errors that are 5xx are already captured server-side via
  // handleError, so they're deliberately left uncaptured here.
  const [sentryEventId, setSentryEventId] = useState<string | null>(null);
  useEffect(() => {
    if (!window.env?.SENTRY_DSN) {
      return;
    }

    if (response instanceof Error && !error404.isError404) {
      setSentryEventId(
        Sentry.captureException(response, {
          tags: { source: "error-boundary" },
        })
      );
      return;
    }

    if (shouldCaptureRouteError) {
      // Synthetic Error (rather than `response`, which is a plain
      // route-error data object here, not an Error instance) so Sentry
      // groups the issue sensibly by message, like any other captured
      // exception. Not stored in `sentryEventId`: the route-error path
      // shows the shelf trace id to the user, not the Sentry event id.
      //
      // `shelf_trace_id`/`label` are only present on Shelf-thrown errors
      // (see `isRouteError` above); a router-generated 404 has neither, so
      // both are omitted entirely here rather than sent as the literal
      // string "undefined".
      Sentry.captureException(new Error(sentryMessage), {
        tags: {
          source: "error-boundary",
          status: errorStatus,
          ...(traceId ? { shelf_trace_id: traceId } : {}),
          ...(errorLabel ? { label: errorLabel } : {}),
        },
        contexts: { route: { pathname: loc.pathname } },
      });
    }
  }, [
    response,
    error404.isError404,
    shouldCaptureRouteError,
    sentryMessage,
    traceId,
    errorLabel,
    errorStatus,
    loc.pathname,
  ]);

  if (error404.isError404) {
    return (
      <Error404Handler
        className={className}
        additionalData={error404.additionalData}
      />
    );
  }

  if (isNotFound) {
    return (
      <IoioErrorScreen
        className={className}
        title={errorPageTitle}
        message={notFoundMessage}
        actions={
          <BackToIoioButton
            to={loc.pathname.startsWith("/ioio") ? "/ioio" : "/home"}
          />
        }
      />
    );
  }

  if (isRateLimited) {
    return (
      <IoioErrorScreen
        className={className}
        title={errorPageTitle}
        message={rateLimitMessage}
        actions={
          <>
            <Button
              to={`${loc.pathname}${loc.search}`}
              reloadDocument
              variant="primary"
              className={IOIO_PRIMARY_BUTTON_CLASS}
            >
              Try again
            </Button>
            <BackToIoioButton
              to={loc.pathname.startsWith("/ioio") ? "/ioio" : "/home"}
            />
          </>
        }
      />
    );
  }

  return (
    <>
      <IoioErrorScreen
        className={className}
        title={errorPageTitle}
        message={IOIO_ERROR_COPY.unexpected}
        actions={
          <>
            <Button
              to={`${loc.pathname}${loc.search}`}
              reloadDocument
              variant="primary"
              className={IOIO_PRIMARY_BUTTON_CLASS}
            >
              Try again
            </Button>
            <BackToIoioButton
              to={loc.pathname.startsWith("/ioio") ? "/ioio" : "/home"}
            />
            {user && !reportBroken ? (
              <Button
                type="button"
                variant="secondary"
                onClick={() => setReportOpen(true)}
              >
                Report this issue
              </Button>
            ) : null}
          </>
        }
      />

      {/* Mounted only while open: keeps the modal's hooks/effects off
      every error render and resets its state on each reopen. Rendered as
      a Portal (see DialogPortal), so its position here relative to
      ErrorScreenLayout has no visual effect. */}
      {user && !reportBroken && reportOpen ? (
        <ReportModalBoundary
          onError={() => {
            setReportBroken(true);
            setReportOpen(false);
          }}
        >
          <Suspense fallback={null}>
            <FeedbackModal
              open={reportOpen}
              onClose={() => setReportOpen(false)}
              errorContext={{
                traceId,
                sentryEventId: sentryEventId ?? undefined,
                errorStatus,
                errorTitle: reportErrorTitle,
                errorMessage: reportErrorMessage,
              }}
            />
          </Suspense>
        </ReportModalBoundary>
      ) : null}
    </>
  );
};

export const ErrorIcon = () => (
  <svg
    width="56px"
    height="56px"
    viewBox="0 0 56 56"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path d="M56 0H0V56H56V0Z" fill="currentColor" />
    <rect x="11.9" y="25.375" width="4.2" height="18.375" fill="white" />
    <rect x="18.9" y="32.375" width="4.2" height="11.375" fill="white" />
    <rect x="25.9" y="25.375" width="4.2" height="18.375" fill="white" />
    <rect x="32.9" y="30.625" width="4.2" height="13.125" fill="white" />
    <rect x="39.9" y="25.375" width="4.2" height="18.375" fill="white" />
    <rect
      x="11.375"
      y="25.375"
      width="5.25"
      height="8.75"
      fill="currentColor"
    />
    <rect
      x="39.375"
      y="25.375"
      width="5.25"
      height="9.625"
      fill="currentColor"
    />
    <rect x="32" y="25" width="6" height="7" fill="currentColor" />
    <rect x="25" y="25" width="7" height="6" fill="currentColor" />
    <rect
      x="14"
      y="20.125"
      width="4.375"
      height="6.125"
      transform="rotate(-90 14 20.125)"
      fill="white"
    />
    <rect
      x="36.75"
      y="20.125"
      width="4.375"
      height="5.25"
      transform="rotate(-90 36.75 20.125)"
      fill="white"
    />
  </svg>
);
