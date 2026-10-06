import { useEffect, useId, useRef, useState } from "react";
import type {
  ChangeEvent,
  ChangeEventHandler,
  DragEvent,
  ReactNode,
} from "react";
import { ImagePlus, Upload } from "lucide-react";
import { Button } from "~/components/shared/button";
import { tw } from "~/utils/tw";

type Props = {
  name: string;
  label?: string;
  accept: string;
  disabled?: boolean;
  error?: string;
  existingPreview?: ReactNode;
  canRemoveExisting?: boolean;
  onChange?: ChangeEventHandler<HTMLInputElement>;
  onRemove?: () => void;
  uploading?: boolean;
};

function setDroppedFile(input: HTMLInputElement, file: File) {
  const dataTransfer = new DataTransfer();
  dataTransfer.items.add(file);
  input.files = dataTransfer.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

/**
 * Shared image field for the IOIO-facing asset, kit, and location forms.
 * The real file input remains in the DOM for form submission and accessibility,
 * while the visible control stays independent of browser locale and styling.
 */
export function IoioImagePicker({
  name,
  label = "Main image",
  accept,
  disabled = false,
  error,
  existingPreview,
  canRemoveExisting = false,
  onChange,
  onRemove,
  uploading = false,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const helpId = `${inputId}-help`;
  const [localPreviewUrl, setLocalPreviewUrl] = useState<string>();
  const [isDragActive, setIsDragActive] = useState(false);

  useEffect(
    () => () => {
      if (localPreviewUrl) URL.revokeObjectURL(localPreviewUrl);
    },
    [localPreviewUrl]
  );

  const handleInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    onChange?.(event);
    const file = event.currentTarget.files?.[0];
    setLocalPreviewUrl(file ? URL.createObjectURL(file) : undefined);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragActive(false);
    if (disabled || uploading) return;

    const file = event.dataTransfer.files[0];
    if (!file || !inputRef.current) return;
    setDroppedFile(inputRef.current, file);
  };

  const clearImage = () => {
    if (inputRef.current) inputRef.current.value = "";
    setLocalPreviewUrl(undefined);
    onRemove?.();
  };

  const preview = localPreviewUrl ? (
    <img
      src={localPreviewUrl}
      alt="Selected upload preview"
      className="size-full object-contain"
    />
  ) : (
    existingPreview
  );
  const hasPreview = Boolean(preview);

  return (
    <div className="w-full">
      <div
        className={tw(
          "rounded-xl border border-dashed border-gray-300 bg-gray-50/60 p-3 transition sm:p-4",
          isDragActive && "border-red-500 bg-red-50/60",
          disabled && "opacity-70"
        )}
        onDragEnter={(event) => {
          event.preventDefault();
          if (!disabled && !uploading) setIsDragActive(true);
        }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={(event) => {
          if (event.currentTarget === event.target) setIsDragActive(false);
        }}
        onDrop={handleDrop}
      >
        {hasPreview ? (
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <div className="flex size-24 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-gray-200 bg-white p-1 sm:size-28 [&_img]:size-full [&_img]:object-contain">
              {preview}
            </div>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-gray-900">{label}</p>
              <p className="mt-1 text-xs text-gray-600">
                {uploading ? "Uploading image..." : "Image selected"}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={disabled || uploading}
                  onClick={() => inputRef.current?.click()}
                >
                  Change image
                </Button>
                {canRemoveExisting || localPreviewUrl ? (
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={disabled || uploading}
                    onClick={clearImage}
                  >
                    Remove
                  </Button>
                ) : null}
              </div>
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center px-3 py-5 text-center">
            <span className="flex size-10 items-center justify-center rounded-full bg-white text-red-700 shadow-sm ring-1 ring-gray-200">
              <ImagePlus aria-hidden="true" className="size-5" />
            </span>
            <p className="mt-3 text-sm font-semibold text-gray-900">
              Drop an image here
            </p>
            <p className="mt-1 text-xs text-gray-500">or</p>
            <button
              type="button"
              className="box-shadow-xs mt-2 inline-flex max-w-xl flex-row items-center justify-center gap-2 whitespace-nowrap rounded border border-primary-400 bg-primary-500 px-[14px] py-2 text-center text-sm font-semibold text-white focus:ring-2 enabled:hover:bg-primary-400 disabled:border-primary-300 disabled:bg-primary-300"
              disabled={disabled || uploading}
              onClick={() => inputRef.current?.click()}
            >
              <Upload
                aria-hidden="true"
                className="!inline-block size-4 shrink-0"
                style={{ display: "inline-block" }}
              />
              <span className="whitespace-nowrap">Browse images</span>
            </button>
          </div>
        )}
        <p id={helpId} className="mt-3 text-center text-xs text-gray-500">
          PNG, JPG, JPEG or WebP · Max 8 MB
        </p>
      </div>
      <input
        ref={inputRef}
        id={inputId}
        name={name}
        type="file"
        accept={accept}
        disabled={disabled || uploading}
        onChange={handleInputChange}
        aria-label={label}
        aria-describedby={helpId}
        className="sr-only"
      />
      {error ? (
        <p role="alert" className="mt-2 text-sm text-error-500">
          {error}
        </p>
      ) : null}
    </div>
  );
}
