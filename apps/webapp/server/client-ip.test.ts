import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";

import { getClientIp } from "./client-ip";

// @vitest-environment node

/**
 * Resolves `getClientIp` for a single request carrying the given headers, by
 * running it inside a throwaway Hono handler (the only way to obtain a real
 * `Context`).
 */
async function resolve(headers: Record<string, string>): Promise<string> {
  const app = new Hono();
  let captured = "";
  app.get("/", (c) => {
    captured = getClientIp(c);
    return c.text("ok");
  });
  await app.request("/", { headers });
  return captured;
}

describe("getClientIp", () => {
  afterEach(() => {
    // why: tests below mutate FLY_APP_NAME via stubEnv; restore between cases.
    vi.unstubAllEnvs();
  });

  it("on Fly, trusts Fly-Client-IP and ignores X-Forwarded-For", async () => {
    vi.stubEnv("FLY_APP_NAME", "shelf-webapp");
    const ip = await resolve({
      "Fly-Client-IP": "203.0.113.7",
      "X-Forwarded-For": "1.2.3.4",
    });
    expect(ip).toBe("203.0.113.7");
  });

  it("on Fly, rejects malformed Fly-Client-IP values", async () => {
    vi.stubEnv("FLY_APP_NAME", "shelf-webapp");
    expect(await resolve({ "Fly-Client-IP": "attacker-controlled" })).toBe(
      "unknown"
    );
  });

  it("on Fly, returns 'unknown' when Fly-Client-IP is absent (never trusts XFF)", async () => {
    // why: on Fly a spoofable client-supplied header must never mint a bucket;
    // FLY_APP_NAME is the runtime signal that we are on the Fly edge.
    vi.stubEnv("FLY_APP_NAME", "shelf-webapp");
    const ip = await resolve({ "X-Forwarded-For": "9.9.9.9, 10.0.0.5" });
    expect(ip).toBe("unknown");
  });

  it("off Fly, trusts XFF only when explicitly configured", async () => {
    // why: local Hono requests cannot reproduce a real proxy boundary; the
    // config is injected to verify the operator opt-in and the parser.
    vi.stubEnv("FLY_APP_NAME", "");
    vi.stubEnv("TRUSTED_PROXY_HEADER", "x-forwarded-for");
    const ip = await resolve({ "X-Forwarded-For": "9.9.9.9" });
    expect(ip).toBe("9.9.9.9");
  });

  it("off Fly, rejects XFF chains instead of guessing which hop is the client", async () => {
    vi.stubEnv("FLY_APP_NAME", "");
    vi.stubEnv("TRUSTED_PROXY_HEADER", "x-forwarded-for");
    const ip = await resolve({ "X-Forwarded-For": "9.9.9.9, 10.0.0.5" });
    expect(ip).toBe("unknown");
  });

  it("off Fly, accepts Cloudflare's client header only when explicitly configured", async () => {
    vi.stubEnv("FLY_APP_NAME", "");
    vi.stubEnv("TRUSTED_PROXY_HEADER", "cf-connecting-ip");
    expect(await resolve({ "CF-Connecting-IP": "2001:db8::7" })).toBe(
      "2001:db8::7"
    );
  });

  it("normalizes equivalent IPv6 and IPv4-mapped IPv6 addresses", async () => {
    vi.stubEnv("FLY_APP_NAME", "");
    vi.stubEnv("TRUSTED_PROXY_HEADER", "cf-connecting-ip");
    expect(await resolve({ "CF-Connecting-IP": "2001:0db8:0:0:0:0:0:1" })).toBe(
      "2001:db8::1"
    );
    expect(await resolve({ "CF-Connecting-IP": "::ffff:192.0.2.1" })).toBe(
      "192.0.2.1"
    );
    expect(await resolve({ "CF-Connecting-IP": "::ffff:c000:201" })).toBe(
      "192.0.2.1"
    );
  });

  it("off Fly, IGNORES a forged Fly-Client-IP (cannot mint buckets)", async () => {
    // why: off Fly, Fly-Client-IP is just another client-supplied header; an
    // attacker must not be able to rotate it to bypass the rate limiter.
    vi.stubEnv("FLY_APP_NAME", "");
    const ip = await resolve({ "Fly-Client-IP": "6.6.6.6" });
    expect(ip).toBe("unknown");
  });

  it("off Fly, ignores every forwarding header without explicit trust configuration", async () => {
    vi.stubEnv("FLY_APP_NAME", "");
    vi.stubEnv("TRUSTED_PROXY_HEADER", "");
    expect(
      await resolve({
        "X-Forwarded-For": "1.2.3.4",
        "CF-Connecting-IP": "5.6.7.8",
      })
    ).toBe("unknown");
  });

  it("returns 'unknown' when no usable header is present", async () => {
    vi.stubEnv("FLY_APP_NAME", "");
    const ip = await resolve({});
    expect(ip).toBe("unknown");
  });
});
