import { isQrId } from "~/utils/id";

export type QrScanAudience = "student" | "staff";

export type QrScanPayload =
  | { kind: "location"; locationId: string }
  | { kind: "shelf-qr"; qrId: string }
  | { kind: "invalid" };

export type ResolvedQrTarget =
  | { kind: "asset"; assetId: string }
  | { kind: "kit"; kitId: string }
  | { kind: "location"; locationId: string };

/** Parse already-issued Shelf asset/kit QR URLs and IOIO location-label URLs. */
export function parseInventoryQrValue(
  value: string,
  baseUrl = "https://shelf.nu"
): QrScanPayload {
  const trimmed = value.trim();
  if (!trimmed) return { kind: "invalid" };

  try {
    const url = new URL(trimmed, baseUrl);
    const locationId = url.searchParams.get("location");
    if (url.pathname.replace(/\/+$/u, "") === "/ioio/browse" && locationId) {
      return { kind: "location", locationId };
    }

    const qrMatch = url.pathname.match(/\/qr\/([a-zA-Z0-9]+)\/?$/u);
    if (qrMatch && isQrId(qrMatch[1])) {
      return { kind: "shelf-qr", qrId: qrMatch[1] };
    }
    const shortQrMatch = url.pathname.match(/^\/([a-zA-Z0-9]+)\/?$/u);
    if (shortQrMatch && isQrId(shortQrMatch[1])) {
      return { kind: "shelf-qr", qrId: shortQrMatch[1] };
    }
  } catch {
    // Raw Shelf QR ids are accepted below.
  }

  if (isQrId(trimmed)) {
    return { kind: "shelf-qr", qrId: trimmed };
  }
  return { kind: "invalid" };
}

export function getInventoryQrDestination(
  target: ResolvedQrTarget,
  audience: QrScanAudience
) {
  if (target.kind === "location") {
    const params = new URLSearchParams({ location: target.locationId });
    return `${audience === "student" ? "/ioio/browse" : "/assets"}?${params}`;
  }

  if (target.kind === "asset") {
    return audience === "student"
      ? `/ioio/browse/${encodeURIComponent(target.assetId)}`
      : `/assets/${encodeURIComponent(target.assetId)}/overview`;
  }

  return audience === "student"
    ? `/ioio/kits?kit=${encodeURIComponent(target.kitId)}`
    : `/kits/${encodeURIComponent(target.kitId)}`;
}
