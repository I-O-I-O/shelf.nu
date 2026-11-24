/**
 * QR readers return either the QR token or the complete label URL. IOIO labels
 * can be scanned from a different host than the current browser, so host
 * matching is intentionally not part of this normalization.
 */
export function normalizeQrScanValue(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";

  let pathname = "";
  try {
    pathname = new URL(trimmed, "https://shelf.invalid").pathname;
  } catch {
    return trimmed;
  }

  const pathMatch = pathname.match(/(?:^|\/)qr\/([^/]+)\/?$/u);
  if (!pathMatch?.[1]) return trimmed;

  try {
    return decodeURIComponent(pathMatch[1]);
  } catch {
    return pathMatch[1];
  }
}
