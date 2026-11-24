/** Browsers expose copied images as clipboard items, files, or both. */
export function getClipboardImage(
  clipboard: DataTransfer | null
): File | undefined {
  if (!clipboard) return undefined;
  for (const item of Array.from(clipboard.items ?? [])) {
    if (!item.type.startsWith("image/")) continue;
    const file = item.getAsFile();
    if (file) return file;
  }
  return Array.from(clipboard.files ?? []).find((file) =>
    file.type.startsWith("image/")
  );
}
