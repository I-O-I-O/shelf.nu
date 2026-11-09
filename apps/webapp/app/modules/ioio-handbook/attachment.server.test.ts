import { describe, expect, it } from "vitest";
import {
  sanitizeHandbookAttachmentFilename,
  validateHandbookAttachment,
} from "./attachment.server";
import { handbookAttachmentFilenameFromPath } from "./attachment.shared";

describe("Handbook file attachments", () => {
  it("keeps filenames to safe basenames", () => {
    expect(sanitizeHandbookAttachmentFilename("../../test-sketch.ino")).toBe(
      "test-sketch.ino"
    );
    expect(
      handbookAttachmentFilenameFromPath(
        "handbook-attachments/abc123/notes with spaces.txt"
      )
    ).toBe("notes with spaces.txt");
  });

  it("accepts UTF-8 code and document files with supported extensions", () => {
    expect(
      validateHandbookAttachment({
        filename: "test-sketch.ino",
        contentType: "text/plain",
        bytes: Buffer.from("void setup() {}", "utf8"),
      })
    ).toEqual({ filename: "test-sketch.ino", extension: "ino" });
  });

  it("requires file content to match supported PDF and ZIP signatures", () => {
    expect(() =>
      validateHandbookAttachment({
        filename: "manual.pdf",
        contentType: "application/pdf",
        bytes: Buffer.from("not a pdf"),
      })
    ).toThrow("Upload a valid PDF file.");
    expect(() =>
      validateHandbookAttachment({
        filename: "libraries.zip",
        contentType: "application/zip",
        bytes: Buffer.from("not a zip"),
      })
    ).toThrow("Upload a valid ZIP file.");
  });

  it("rejects unsupported extensions, mismatched MIME types, and binary text", () => {
    expect(() =>
      validateHandbookAttachment({
        filename: "payload.exe",
        contentType: "application/octet-stream",
        bytes: Buffer.from("example"),
      })
    ).toThrow("Use one of these file types");
    expect(() =>
      validateHandbookAttachment({
        filename: "notes.txt",
        contentType: "text/html",
        bytes: Buffer.from("<script>alert(1)</script>"),
      })
    ).toThrow("does not match its filename extension");
    expect(() =>
      validateHandbookAttachment({
        filename: "notes.txt",
        contentType: "text/plain",
        bytes: Buffer.from([0, 1, 2]),
      })
    ).toThrow("cannot contain binary data");
  });
});
