import { isIP } from "node:net";
import type { Context } from "hono";

/**
 * Returns a rate-limit identity only from a proxy header the operator has
 * explicitly configured as trusted.
 *
 * Fly's edge header is used only when the Fly runtime marker is present. On
 * other hosts, `TRUSTED_PROXY_HEADER` must be `x-forwarded-for` or
 * `cf-connecting-ip`. The configured proxy must overwrite the selected header,
 * and the app origin must not be reachable around that proxy. X-Forwarded-For
 * must contain exactly one IP; interpreting a proxy chain without a configured
 * trusted-hop count could select a client-forged value.
 *
 * Missing, malformed, or untrusted input returns `"unknown"`, which fail-closes
 * the IP-based rate-limit bucket instead of allowing a caller to rotate forged
 * headers to bypass throttling.
 */
export function getClientIp(
  c: Context,
  config: NodeJS.ProcessEnv = process.env
): string {
  if (config.FLY_APP_NAME) {
    return trustedIp(c.req.header("fly-client-ip"));
  }

  switch (config.TRUSTED_PROXY_HEADER?.toLowerCase()) {
    case "x-forwarded-for":
      return trustedIp(c.req.header("x-forwarded-for"), true);
    case "cf-connecting-ip":
      return trustedIp(c.req.header("cf-connecting-ip"));
    default:
      return "unknown";
  }
}

function trustedIp(value: string | undefined, requireSingle = false): string {
  const ip = value?.trim();
  const version = ip ? isIP(ip) : 0;
  if (!ip || (requireSingle && ip.includes(",")) || version === 0) {
    return "unknown";
  }

  if (version === 4) return ip;

  // URL's IPv6 parser provides a stable compressed representation, so
  // equivalent textual forms share the same rate-limit bucket.
  const normalized = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
  const mappedIpv4 = normalized.match(
    /^::ffff:([\da-f]{1,4}):([\da-f]{1,4})$/i
  );
  if (mappedIpv4) {
    const high = Number.parseInt(mappedIpv4[1], 16);
    const low = Number.parseInt(mappedIpv4[2], 16);
    return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
  }

  return normalized.toLowerCase();
}
