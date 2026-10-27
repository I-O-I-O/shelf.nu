import {
  ImportHelperValidationError,
  importHelperRequestSchema,
  parseAndValidateImportHelperResponse,
  type AnyImportHelperRequest,
  type AnyImportHelperResponse,
} from "./import-helper-contract.server";

export const DEFAULT_IMPORT_HELPER_TIMEOUT_MS = 20_000;
export const MAX_IMPORT_HELPER_RESPONSE_BYTES = 2_000_000;

export type ImportHelperManualReason =
  | "not-configured"
  | "timeout"
  | "unavailable"
  | "invalid-response";

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

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
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

  const endpoint = config.endpoint?.trim();
  const authToken = config.authToken?.trim();
  if (!endpoint || !authToken || !isValidEndpoint(endpoint)) {
    return { status: "manual", reason: "not-configured" };
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
      body: JSON.stringify(parsedRequest.data),
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) return { status: "manual", reason: "unavailable" };

    const responseText = await response.text();
    if (
      new TextEncoder().encode(responseText).byteLength >
      MAX_IMPORT_HELPER_RESPONSE_BYTES
    ) {
      return { status: "manual", reason: "invalid-response" };
    }
    try {
      const proposal = parseAndValidateImportHelperResponse(
        responseText,
        parsedRequest.data
      );
      return { status: "ready", proposal };
    } catch (error) {
      if (error instanceof ImportHelperValidationError) {
        return { status: "manual", reason: "invalid-response" };
      }
      throw error;
    }
  } catch (error) {
    return {
      status: "manual",
      reason: isAbortError(error) ? "timeout" : "unavailable",
    };
  } finally {
    clearTimeout(timeout);
  }
}
