import { useEffect, useRef, useState } from "react";
import type { ChangeEvent, RefObject } from "react";
import { getClipboardImage } from "~/utils/clipboard-image";

/** Clipboard uploads share Shelf's canonical multipart endpoint and validation. */
export function useImagePaste({
  inputRef,
  name,
  pasteImages,
  pasteUploadUrl,
  disabled,
  validateFile,
  setPreviewUrl,
  onFileChange,
}: {
  inputRef: RefObject<HTMLInputElement | null>;
  name: string;
  pasteImages?: boolean;
  pasteUploadUrl?: string;
  disabled?: boolean;
  validateFile: (event: ChangeEvent<HTMLInputElement>) => void;
  setPreviewUrl: (url: string | null) => void;
  onFileChange?: (file: File | null) => void;
}) {
  const pasteBusy = useRef(false);
  const [uploading, setUploading] = useState(false);
  const [pasteError, setPasteError] = useState<string>();
  useEffect(() => {
    const input = inputRef.current;
    const form = input?.closest("form");
    if (!pasteImages || !input || !form || disabled) return;
    input.dataset.imagePaste = "enabled";
    const visible = (element: Element) => {
      for (
        let parent: Element | null = element;
        parent;
        parent = parent.parentElement
      ) {
        if (
          parent.hasAttribute("hidden") ||
          parent.hasAttribute("inert") ||
          getComputedStyle(parent).display === "none" ||
          getComputedStyle(parent).visibility === "hidden"
        )
          return false;
      }
      return true;
    };
    const paste = async (event: ClipboardEvent) => {
      if (event.defaultPrevented || !visible(form)) return;
      const target = event.target instanceof Element ? event.target : null;
      const targetForm = target?.closest("form");
      if (targetForm && targetForm !== form) return;
      // Page-focused paste belongs to the sole visible image form, never a
      // background queued draft or a form beneath an open dialog.
      if (!targetForm) {
        if (
          document.querySelector(
            '[role="dialog"][data-state="open"], dialog[open]'
          )
        )
          return;
        const owners = new Set(
          Array.from(
            document.querySelectorAll<HTMLInputElement>(
              'input[data-image-paste="enabled"]'
            )
          )
            .filter(visible)
            .map((field) => field.closest("form"))
        );
        if (owners.size !== 1 || !owners.has(form)) return;
      }
      const file = getClipboardImage(event.clipboardData);
      if (!file) return;
      event.preventDefault();
      if (pasteBusy.current) return;
      const transfer = new DataTransfer();
      transfer.items.add(file);
      // Validate in a scratch input so rejection preserves the previous selection.
      const candidate = document.createElement("input");
      candidate.type = "file";
      candidate.accept = input.accept;
      candidate.files = transfer.files;
      setPasteError(undefined);
      validateFile({
        target: candidate,
        currentTarget: candidate,
      } as ChangeEvent<HTMLInputElement>);
      const accepted = candidate.files?.[0];
      if (!accepted) return;
      if (!pasteUploadUrl) {
        input.files = candidate.files;
        setPreviewUrl(URL.createObjectURL(accepted));
        onFileChange?.(accepted);
        return;
      }
      pasteBusy.current = true;
      setUploading(true);
      try {
        const body = new FormData();
        body.append(name, accepted);
        const response = await fetch(pasteUploadUrl, { method: "POST", body });
        const result = await response.json().catch(() => null);
        if (!response.ok || result?.success !== true)
          throw new Error(
            typeof result?.error === "string"
              ? result.error
              : "Image upload failed. Try again."
          );
        input.value = ""; // Already persisted; Save must not upload a second copy.
        setPreviewUrl(URL.createObjectURL(accepted));
        onFileChange?.(accepted);
      } catch (cause) {
        setPasteError(
          cause instanceof Error
            ? cause.message
            : "Image upload failed. Try again."
        );
      } finally {
        pasteBusy.current = false;
        setUploading(false);
      }
    };
    const submit = (event: Event) => {
      if (pasteBusy.current) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    document.addEventListener("paste", paste);
    form.addEventListener("submit", submit, true);
    return () => {
      delete input.dataset.imagePaste;
      document.removeEventListener("paste", paste);
      form.removeEventListener("submit", submit, true);
    };
  }, [
    disabled,
    inputRef,
    name,
    onFileChange,
    pasteImages,
    pasteUploadUrl,
    setPreviewUrl,
    validateFile,
  ]);

  return {
    uploading,
    pasteError,
    clearPasteError: () => setPasteError(undefined),
  };
}
