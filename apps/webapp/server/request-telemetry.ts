import {
  isSensitiveUrlParam,
  REDACTED_URL_PART,
  redactSensitive,
} from "~/utils/redact";

type RequestTelemetryFields = {
  headers?: Record<string, unknown>;
  cookies?: Record<string, unknown>;
  data?: unknown;
  url?: unknown;
  query_string?: unknown;
};

/**
 * Scrub request metadata before it leaves through Sentry. Header values are
 * redacted by name, all cookie values and request bodies are hidden because
 * they can contain credentials under arbitrary field names.
 */
export function scrubRequestTelemetry<E extends { request?: object }>(
  event: E
): E {
  const extra = (event as E & { extra?: unknown }).extra;
  const safeExtra = extra === undefined ? undefined : redactSensitive(extra);
  if (!event.request) {
    return (
      safeExtra === undefined ? event : { ...event, extra: safeExtra }
    ) as E;
  }

  const request = event.request as RequestTelemetryFields;
  const scrubbedRequest: RequestTelemetryFields = {
    ...request,
    ...(request.headers ? { headers: redactSensitive(request.headers) } : {}),
    ...(request.cookies
      ? {
          cookies: Object.fromEntries(
            Object.keys(request.cookies).map((name) => [name, "[REDACTED]"])
          ),
        }
      : {}),
    ...(request.data === undefined ? {} : { data: "[REDACTED]" }),
    ...(typeof request.url === "string"
      ? { url: redactSensitive(request.url) }
      : {}),
    ...(typeof request.query_string === "string"
      ? { query_string: scrubQueryString(request.query_string) }
      : {}),
  };

  return {
    ...event,
    request: scrubbedRequest,
    ...(safeExtra === undefined ? {} : { extra: safeExtra }),
  } as E;
}

function scrubQueryString(query: string): string {
  const params = new URLSearchParams(query.replace(/^\?/, ""));
  let redacted = false;
  for (const key of Array.from(params.keys())) {
    if (isSensitiveUrlParam(key)) {
      params.set(key, REDACTED_URL_PART);
      redacted = true;
    }
  }
  return redacted ? params.toString() : query;
}
