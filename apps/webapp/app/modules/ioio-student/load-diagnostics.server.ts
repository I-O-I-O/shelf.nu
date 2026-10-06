type DiagnosticError = {
  name?: unknown;
  message?: unknown;
  code?: unknown;
  cause?: unknown;
  meta?: { code?: unknown; modelName?: unknown };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function redactDiagnosticMessage(value: string) {
  return value
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s)]+/giu, "[url]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, "[email]")
    .replace(
      /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu,
      "[token]"
    )
    .replace(/\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b/giu, "[id]")
    .replace(
      /\b(password|token|cookie|authorization|secret|service[_-]?role|api[_-]?key|anon[_-]?key)\s*[:=]\s*\S+/giu,
      "$1=[redacted]"
    )
    .slice(0, 600);
}

function safeErrorDetails(error: unknown) {
  const outer = (isRecord(error) ? error : {}) as DiagnosticError;
  const chain: DiagnosticError[] = [outer];
  let underlying = outer;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!isRecord(underlying.cause)) break;
    underlying = underlying.cause as DiagnosticError;
    chain.push(underlying);
  }
  const metadata = chain.map((item) => (isRecord(item.meta) ? item.meta : {}));
  const rawMessage =
    typeof underlying.message === "string"
      ? underlying.message
      : typeof outer.message === "string"
      ? outer.message
      : error instanceof Error
      ? error.message
      : String(error);
  const prismaCode = chain
    .map((item) => item.code)
    .find(
      (code): code is string =>
        typeof code === "string" && /^P\d{4}$/u.test(code)
    );
  const sqlState = metadata
    .map((item) => item.code)
    .find(
      (code): code is string =>
        typeof code === "string" && /^[0-9A-Z]{5}$/u.test(code)
    );
  const modelName = metadata
    .map((item) => item.modelName)
    .find((name): name is string => typeof name === "string");

  return {
    errorName:
      typeof underlying.name === "string" ? underlying.name : typeof error,
    wrapperErrorName:
      typeof outer.name === "string" && outer !== underlying
        ? outer.name
        : undefined,
    prismaCode,
    sqlState,
    modelName,
    message: redactDiagnosticMessage(rawMessage),
  };
}

export function logIoioStudentLoadStage(
  stage: string,
  status: "STARTED" | "OK" | "SKIPPED",
  enabled: boolean
) {
  if (!enabled || process.env.NODE_ENV !== "development") return;
  console.info(`[IOIO STUDENT LOAD] ${stage}: ${status}`);
}

const reportedErrors = new WeakSet<object>();

export function logIoioStudentLoadFailure(
  stage: string,
  error: unknown,
  enabled: boolean
) {
  if (!enabled || process.env.NODE_ENV !== "development") return;
  if (typeof error === "object" && error !== null) {
    if (reportedErrors.has(error)) return;
    reportedErrors.add(error);
  }
  console.error("[IOIO STUDENT LOAD FAILED]", {
    stage,
    ...safeErrorDetails(error),
  });
}

export async function withIoioStudentLoadStage<T>(
  stage: string,
  enabled: boolean,
  operation: () => T | Promise<T>
): Promise<T> {
  if (!enabled || process.env.NODE_ENV !== "development") return operation();

  try {
    const result = await operation();
    logIoioStudentLoadStage(stage, "OK", enabled);
    return result;
  } catch (cause) {
    logIoioStudentLoadFailure(stage, cause, enabled);
    throw cause;
  }
}
