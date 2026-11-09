import { randomUUID } from "node:crypto";
import { getSupabaseAdmin } from "~/integrations/supabase/client";

export const HANDBOOK_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export const HANDBOOK_ATTACHMENT_MAX_FILES = 5;
export const HANDBOOK_ATTACHMENT_MAX_TOTAL_BYTES =
  HANDBOOK_ATTACHMENT_MAX_BYTES * HANDBOOK_ATTACHMENT_MAX_FILES;

const allowedMimeTypes: Record<string, string[]> = {
  ino: ["text/plain", "text/x-arduino", "application/octet-stream"],
  c: ["text/plain", "text/x-c", "application/octet-stream"],
  cpp: [
    "text/plain",
    "text/x-c++",
    "text/x-c++src",
    "application/octet-stream",
  ],
  h: ["text/plain", "text/x-c", "application/octet-stream"],
  hpp: [
    "text/plain",
    "text/x-c++",
    "text/x-c++src",
    "application/octet-stream",
  ],
  py: ["text/plain", "text/x-python", "application/octet-stream"],
  js: [
    "text/plain",
    "text/javascript",
    "application/javascript",
    "application/octet-stream",
  ],
  ts: ["text/plain", "application/typescript", "application/octet-stream"],
  json: ["application/json", "text/plain", "application/octet-stream"],
  txt: ["text/plain", "application/octet-stream"],
  md: [
    "text/markdown",
    "text/x-markdown",
    "text/plain",
    "application/octet-stream",
  ],
  csv: ["text/csv", "text/plain", "application/octet-stream"],
  yaml: [
    "text/yaml",
    "application/x-yaml",
    "text/plain",
    "application/octet-stream",
  ],
  yml: [
    "text/yaml",
    "application/x-yaml",
    "text/plain",
    "application/octet-stream",
  ],
  pdf: ["application/pdf", "application/octet-stream"],
  zip: [
    "application/zip",
    "application/x-zip-compressed",
    "application/octet-stream",
  ],
};

export function sanitizeHandbookAttachmentFilename(value: string) {
  const basename = value.replace(/\\/gu, "/").split("/").pop() ?? "";
  const sanitized = basename
    .normalize("NFC")
    .replace(/\p{Cc}/gu, "")
    .replace(/[^\p{L}\p{N}._ ()-]/gu, "_")
    .replace(/\s+/gu, " ")
    .replace(/^\.+/u, "")
    .replace(/[. ]+$/u, "")
    .slice(0, 120);
  return sanitized || "handbook-file";
}

export function validateHandbookAttachment({
  filename,
  contentType,
  bytes,
}: {
  filename: string;
  contentType: string;
  bytes: Buffer;
}) {
  const safeFilename = sanitizeHandbookAttachmentFilename(filename);
  const extension = safeFilename.split(".").pop()?.toLowerCase() ?? "";
  const mimeType = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  const allowedTypes = allowedMimeTypes[extension];
  if (!allowedTypes) {
    throw new Error(
      "Use one of these file types: INO, C, CPP, H, HPP, PY, JS, TS, JSON, TXT, MD, CSV, YAML, YML, PDF, or ZIP."
    );
  }
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength > HANDBOOK_ATTACHMENT_MAX_BYTES
  ) {
    throw new Error(
      "Each file must be larger than 0 bytes and 10 MB or smaller."
    );
  }
  if (mimeType && !allowedTypes.includes(mimeType)) {
    throw new Error("The file type does not match its filename extension.");
  }

  if (["pdf", "zip"].includes(extension)) {
    const validSignature =
      extension === "pdf"
        ? bytes.subarray(0, 5).toString("ascii") === "%PDF-"
        : bytes.length >= 4 &&
          bytes[0] === 0x50 &&
          bytes[1] === 0x4b &&
          ((bytes[2] === 0x03 && bytes[3] === 0x04) ||
            (bytes[2] === 0x05 && bytes[3] === 0x06) ||
            (bytes[2] === 0x07 && bytes[3] === 0x08));
    if (!validSignature) {
      throw new Error(`Upload a valid ${extension.toUpperCase()} file.`);
    }
  } else {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error("Text and code attachments must use UTF-8 encoding.");
    }
    if (bytes.includes(0)) {
      throw new Error("Text and code attachments cannot contain binary data.");
    }
  }

  return { filename: safeFilename, extension };
}

export async function uploadHandbookAttachmentObject({
  filename,
  bytes,
}: {
  filename: string;
  bytes: Buffer;
}) {
  const objectPath = `handbook-attachments/${randomUUID()}/${filename}`;
  const { error } = await getSupabaseAdmin()
    .storage.from("assets")
    .upload(objectPath, bytes, {
      contentType: "application/octet-stream",
      upsert: false,
    });
  if (error) throw error;
  return objectPath;
}
