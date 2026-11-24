export const HANDBOOK_ATTACHMENT_ACCEPT =
  ".ino,.c,.cpp,.h,.hpp,.py,.js,.ts,.json,.txt,.md,.csv,.yaml,.yml,.pdf,.zip";

export function handbookAttachmentFilenameFromPath(path: string) {
  const basename = path.replace(/\\/gu, "/").split("/").pop() ?? "";
  const sanitized = basename
    .normalize("NFC")
    .replace(/\p{Cc}/gu, "")
    .replace(/[^\p{L}\p{N}._ ()-]/gu, "_")
    .replace(/^\.+/u, "")
    .replace(/[. ]+$/u, "")
    .slice(0, 120);
  return sanitized || "handbook-file";
}
