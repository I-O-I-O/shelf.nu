import { db } from "~/database/db.server";
import { HEALTHCHECK_DB_TIMEOUT_MS } from "./healthcheck.shared";

/**
 * Internal budget for the DB probe, comfortably under Fly's HTTP check timeout.
 * A saturated connection pool should not make the app appear dead.
 */
const HEALTHCHECK_TIMEOUT = Symbol("healthcheck-timeout");

/**
 * Reuses the database probe behind /healthcheck. A slow probe is considered
 * degraded-but-alive; a fast rejection is a health issue.
 */
export async function checkApplicationHealth(): Promise<
  "healthy" | "degraded"
> {
  const probe = db.user.findFirst({ select: { id: true } });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof HEALTHCHECK_TIMEOUT>((resolve) => {
    timer = setTimeout(
      () => resolve(HEALTHCHECK_TIMEOUT),
      HEALTHCHECK_DB_TIMEOUT_MS
    );
  });

  try {
    const result = await Promise.race([probe, timeout]);
    if (result === HEALTHCHECK_TIMEOUT) {
      // why: the timed-out query may reject after this request has completed.
      void probe.catch(() => {});
      return "degraded";
    }
    return "healthy";
  } finally {
    clearTimeout(timer);
  }
}
