import { Logger } from "~/utils/logger";
import {
  ImportHelperValidationError,
  importHelperRequestSchema,
  parseAndValidateImportHelperResponse,
  type AnyImportHelperRequest,
  type AnyImportHelperResponse,
} from "./import-helper-contract.server";

export const DEFAULT_IMPORT_HELPER_TIMEOUT_MS = 20_000;
export const MAX_IMPORT_HELPER_RESPONSE_BYTES = 2_000_000;
export const IMPORT_HELPER_HEALTH_TIMEOUT_MS = 1200;

export type ImportHelperManualReason =
  | "helper_not_configured"
  | "network_error"
  | "timeout"
  | "unauthorized_401"
  | "invalid_request_400"
  | "helper_busy_503"
  | "helper_inference_502"
  | "helper_http_error"
  | "invalid_response";

export type ImportHelperResultClassification =
  | ImportHelperManualReason
  | "success";

export type ImportHelperClientResult =
  | { status: "ready"; proposal: AnyImportHelperResponse }
  | { status: "manual"; reason: ImportHelperManualReason };

export type ImportHelperClientConfig = {
  endpoint?: string;
  authToken?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

function getRuntimeConfig(): ImportHelperClientConfig {
  const timeoutValue = Number(process.env.IOIO_IMPORT_HELPER_TIMEOUT_MS);
  const timeoutMs =
    Number.isSafeInteger(timeoutValue) &&
    timeoutValue > 0 &&
    timeoutValue <= 120_000
      ? timeoutValue
      : DEFAULT_IMPORT_HELPER_TIMEOUT_MS;
  return {
    endpoint: process.env.IOIO_IMPORT_HELPER_URL?.trim(),
    authToken: process.env.IOIO_IMPORT_HELPER_AUTH_TOKEN?.trim(),
    timeoutMs,
  };
}

function isValidEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    if (url.username || url.password) return false;
    if (url.protocol === "https:") return true;
    return (
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    );
  } catch {
    return false;
  }
}

export type ImportHelperHealth = {
  status: "ok" | "unavailable";
  storageUsedPercent: number | null;
};

/** Probe the persistent helper without inference or the long import timeout.
 * Only health data leaves this server-side client, never connection details. */
export async function getImportHelperHealth(
  config: ImportHelperClientConfig = getRuntimeConfig()
): Promise<ImportHelperHealth> {
  const unavailable: ImportHelperHealth = {
    status: "unavailable",
    storageUsedPercent: null,
  };
  const endpoint = config.endpoint?.trim();
  const authToken = config.authToken?.trim();
  if (!endpoint || !authToken || !isValidEndpoint(endpoint)) return unavailable;

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    IMPORT_HELPER_HEALTH_TIMEOUT_MS
  );
  try {
    const response = await (config.fetchImpl ?? fetch)(
      new URL("/health", endpoint),
      {
        method: "GET",
        headers: { authorization: `Bearer ${authToken}` },
        redirect: "error",
        cache: "no-store",
        signal: controller.signal,
      }
    );
    if (!response.ok) return unavailable;
    const text = await response.text();
    if (text.length > 2048) return unavailable;
    const body: unknown = JSON.parse(text);
    if (
      !body ||
      typeof body !== "object" ||
      !("status" in body) ||
      body.status !== "ok"
    )
      return unavailable;
    const percent =
      "storageUsedPercent" in body ? body.storageUsedPercent : null;
    const storageUsedPercent =
      typeof percent === "number" &&
      Number.isFinite(percent) &&
      percent >= 0 &&
      percent <= 100
        ? Math.round(percent)
        : null;
    return { status: "ok", storageUsedPercent };
  } catch {
    return unavailable;
  } finally {
    clearTimeout(timer);
  }
}

/** Storage consumers share the same health probe and configuration parsing. */
export async function getImportHelperStorageUsedPercent(
  config: ImportHelperClientConfig = getRuntimeConfig()
): Promise<number | null> {
  return (await getImportHelperHealth(config)).storageUsedPercent;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function classifyHttpFailure(status: number): ImportHelperManualReason {
  switch (status) {
    case 400:
      return "invalid_request_400";
    case 401:
      return "unauthorized_401";
    case 502:
      return "helper_inference_502";
    case 503:
      return "helper_busy_503";
    default:
      return "helper_http_error";
  }
}

export async function requestImportHelperProposal(
  requestInput: AnyImportHelperRequest | unknown,
  config: ImportHelperClientConfig = getRuntimeConfig()
): Promise<ImportHelperClientResult> {
  const parsedRequest = importHelperRequestSchema.safeParse(requestInput);
  if (!parsedRequest.success) {
    throw new ImportHelperValidationError(
      "Shelf generated an invalid import helper request."
    );
  }

  const mode =
    "mode" in parsedRequest.data ? parsedRequest.data.mode : "GENERIC_IMPORT";
  const requestBody = JSON.stringify(parsedRequest.data);
  const requestBytes = new TextEncoder().encode(requestBody).byteLength;
  const startedAt = Date.now();
  const logResult = (
    result: ImportHelperResultClassification,
    status: number | null
  ) => {
    Logger.info({
      event: "ioio_import_helper_client_result",
      httpStatus: status,
      result,
      requestMode: mode,
      requestBytes,
      durationMs: Date.now() - startedAt,
    });
  };

  const endpoint = config.endpoint?.trim();
  const authToken = config.authToken?.trim();
  if (!endpoint || !authToken || !isValidEndpoint(endpoint)) {
    logResult("helper_not_configured", null);
    return { status: "manual", reason: "helper_not_configured" };
  }

  const controller = new AbortController();
  const timeoutMs = config.timeoutMs ?? DEFAULT_IMPORT_HELPER_TIMEOUT_MS;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await (config.fetchImpl ?? fetch)(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${authToken}`,
      },
      body: requestBody,
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) {
      const reason = classifyHttpFailure(response.status);
      logResult(reason, response.status);
      return { status: "manual", reason };
    }

    const responseText = await response.text();
    if (
      new TextEncoder().encode(responseText).byteLength >
      MAX_IMPORT_HELPER_RESPONSE_BYTES
    ) {
      logResult("invalid_response", response.status);
      return { status: "manual", reason: "invalid_response" };
    }
    try {
      const proposal = parseAndValidateImportHelperResponse(
        responseText,
        parsedRequest.data
      );
      logResult("success", response.status);
      return { status: "ready", proposal };
    } catch (error) {
      if (error instanceof ImportHelperValidationError) {
        logResult("invalid_response", response.status);
        return { status: "manual", reason: "invalid_response" };
      }
      throw error;
    }
  } catch (error) {
    const reason = isAbortError(error) ? "timeout" : "network_error";
    logResult(reason, null);
    return {
      status: "manual",
      reason,
    };
  } finally {
    clearTimeout(timeout);
  }
}
