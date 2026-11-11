/**
 * Image file field: the image upload row every entity form uses (asset, asset
 * model, kit, location, workspace, user profile).
 *
 * The row shows a picture next to the file input:
 * - the saved image (`currentImage`, rendered by the caller, because each
 *   entity stores and serves its images differently), and
 * - once the user picks a file, a local preview of that file instead, before
 *   anything is uploaded.
 *
 * A form without a saved image passes `currentImage={null}`: the picture
 * column only appears when a file is picked.
 *
 * Picked files go through the caller's validation atom (type and size limits,
 * see `~/atoms/file`). A rejected file is cleared from the input by that
 * validator, so the picture falls back to `currentImage` rather than
 * previewing a file that will not be uploaded.
 *
 * Layout: picture on the left; `aboveInput`, the size hint, the input and
 * `belowInput` on the right. The hint sits above the input on large screens
 * and below it on small ones. It is one element moved with CSS `order`, not
 * two copies: `aria-describedby` reads a referenced element even when it is
 * `display: none`, so a second copy would be announced twice.
 *
 * @see {@link file://./input.tsx} The underlying input
 * @see {@link file://../../atoms/file.ts} Validation atoms
 */
import type { ChangeEvent, ReactNode } from "react";
import { useEffect, useId, useRef, useState } from "react";
import type { WritableAtom } from "jotai";
import { useSetAtom } from "jotai";
import { defaultValidateFileAtom } from "~/atoms/file";
import { ACCEPT_SUPPORTED_IMAGES } from "~/utils/constants";
import { tw } from "~/utils/tw";
import Input from "./input";

/** Hint for the default 4 MB limit of {@link defaultValidateFileAtom}. */
export const IMAGE_HINT_4MB = "Accepts PNG, JPG, JPEG, or WebP (max.4 MB)";

/** Hint for the 8 MB limit of the asset, kit and asset-model validators. */
export const IMAGE_HINT_8MB = "Accepts PNG, JPG, JPEG, or WebP (max.8 MB)";

/** Size and shape of the picture, saved or previewed, unless overridden. */
export const IMAGE_FIELD_PICTURE_CLASSES =
  "size-16 rounded border object-cover";

/** A validation atom from `~/atoms/file`: takes the input's change event. */
type ValidateFileAtom = WritableAtom<
  null,
  [ChangeEvent<HTMLInputElement>],
  void
>;

type ImageFileFieldProps = {
  /** Form field name the action reads the file from. */
  name: string;
  /** Enable clipboard images within this field's owning form. */
  pasteImages?: boolean;
  /** Existing entities can persist pasted images immediately. */
  pasteUploadUrl?: string;
  /** Accessible label of the file input (visually hidden). */
  label: string;
  /**
   * Picture of the saved image, or `null` when there is none to show.
   * Shown whenever no valid file is picked.
   */
  currentImage: ReactNode | null;
  /** Alt text of the picked-file preview. */
  previewAlt: string;
  /**
   * Classes of the picked-file preview. Match the size and shape of
   * `currentImage` so the row does not shift when a file is picked.
   */
  previewClassName?: string;
  /** Validation to run on the picked file; defaults to the 4 MB rules. */
  validateFileAtom?: ValidateFileAtom;
  /** Size and format hint; must state the limit `validateFileAtom` applies. */
  hint?: ReactNode;
  /** Extra content above the hint and input (e.g. image source controls). */
  aboveInput?: ReactNode;
  /** Extra content below the input (e.g. where the image is used). */
  belowInput?: ReactNode;
  /**
   * Called after each pick with the file that will be uploaded, or `null`
   * when the input ends up empty (rejected or cleared). Lets the form keep
   * copy about the saved image in step with the picture.
   */
  onFileChange?: (file: File | null) => void;
  /** Error to show under the input (server or client validation). */
  error?: string;
  disabled?: boolean;
};

/**
 * File input with a picture of the saved image and a preview of a picked file.
 *
 * @param props - See {@link ImageFileFieldProps}
 */
export function ImageFileField({
  name,
  pasteImages = false,
  pasteUploadUrl,
  label,
  currentImage,
  previewAlt,
  previewClassName = IMAGE_FIELD_PICTURE_CLASSES,
  validateFileAtom = defaultValidateFileAtom,
  hint = IMAGE_HINT_4MB,
  aboveInput,
  belowInput,
  onFileChange,
  error,
  disabled,
}: ImageFileFieldProps) {
  const validateFile = useSetAtom(validateFileAtom);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const hintId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const pasteBusy = useRef(false);
  const [uploading, setUploading] = useState(false);
  const [pasteError, setPasteError] = useState<string>();

  useEffect(() => {
    const input = inputRef.current;
    const form = input?.closest("form");
    if (!pasteImages || !input || !form || disabled) return;
    const paste = async (event: ClipboardEvent) => {
      if (
        event.defaultPrevented ||
        (event.target instanceof Element &&
          event.target.closest("form") !== form)
      )
        return;
      const item = Array.from(event.clipboardData?.items ?? []).find(
        (entry) => entry.kind === "file" && entry.type.startsWith("image/")
      );
      const file = item?.getAsFile();
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
        const result = await response.json();
        if (!response.ok || result.success !== true)
          throw new Error(
            typeof result.error === "string"
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
    form.addEventListener("paste", paste);
    form.addEventListener("submit", submit, true);
    return () => {
      form.removeEventListener("paste", paste);
      form.removeEventListener("submit", submit, true);
    };
  }, [disabled, name, onFileChange, pasteImages, pasteUploadUrl, validateFile]);

  // Each object URL pins its file in memory until revoked: release the old
  // one when the preview changes, and the last one on unmount.
  useEffect(() => {
    if (!previewUrl) return;
    return () => URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  /**
   * Validates the picked file, then previews it, or falls back to the saved
   * image when the input ends up empty (a rejected file is cleared).
   *
   * @param event - Change event of the file input
   */
  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    setPasteError(undefined);
    validateFile(event);
    // Read the file after validation: a rejected file has been cleared from
    // the input, and an accepted one may have been swapped for a copy with a
    // sanitised name.
    const file = event.target.files?.[0] ?? null;
    setPreviewUrl(file ? URL.createObjectURL(file) : null);
    onFileChange?.(file);
  }

  const picture = previewUrl ? (
    <img src={previewUrl} alt={previewAlt} className={tw(previewClassName)} />
  ) : (
    currentImage
  );

  return (
    <div className="flex gap-3">
      {picture ? <div className="shrink-0">{picture}</div> : null}
      <div className="flex min-w-0 flex-col">
        {aboveInput}
        {/* DOM order is the large-screen order; small screens move the hint
            below the input. */}
        <div id={hintId} className="order-last mt-2 lg:order-none lg:mt-0">
          {hint}
        </div>
        <Input
          ref={inputRef}
          accept={ACCEPT_SUPPORTED_IMAGES}
          name={name}
          type="file"
          onChange={handleChange}
          label={label}
          hideLabel
          aria-describedby={hintId}
          error={pasteError ?? error}
          disabled={disabled || uploading}
          className="mt-2"
          inputClassName="border-0 shadow-none p-0 rounded-none"
        />
        {pasteImages ? (
          <p className="mt-2 text-xs text-gray-500" role="status">
            {uploading
              ? "Uploading image…"
              : pasteUploadUrl
              ? "Paste an image anywhere in this form to upload it immediately."
              : "Paste an image anywhere in this form; Save uploads it."}
          </p>
        ) : null}
        {belowInput ? <div className="order-last">{belowInput}</div> : null}
      </div>
    </div>
  );
}
