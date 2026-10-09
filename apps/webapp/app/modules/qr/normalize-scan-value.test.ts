import { describe, expect, it } from "vitest";
import { normalizeQrScanValue } from "./normalize-scan-value";

describe("normalizeQrScanValue", () => {
  it.each([
    ["http://127.0.0.1:3000/qr/vdqo0i7hk9", "vdqo0i7hk9"],
    ["http://localhost:3000/qr/vdqo0i7hk9", "vdqo0i7hk9"],
    ["/qr/vdqo0i7hk9", "vdqo0i7hk9"],
    ["vdqo0i7hk9", "vdqo0i7hk9"],
    ["https://labels.example/qr/vdqo0i7hk9", "vdqo0i7hk9"],
  ])("normalizes %s", (input, expected) => {
    expect(normalizeQrScanValue(input)).toBe(expected);
  });

  it("leaves non-QR barcodes and unit numbers unchanged", () => {
    expect(normalizeQrScanValue("#003")).toBe("#003");
    expect(normalizeQrScanValue("MAKEY-003")).toBe("MAKEY-003");
  });
});
