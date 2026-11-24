import { useEffect, useRef, useState } from "react";
import type { DragEvent } from "react";
import { ChevronDown } from "lucide-react";
import { Form, useFetcher } from "react-router";
import { Button } from "~/components/shared/button";
import type {
  LabInfoSectionImage,
  LabInfoSectionView,
} from "~/modules/ioio-lab-information/sections.shared";
import { LabInfoContentSection } from "./content-section";

const IMAGE_ACCEPT = "image/png,image/jpeg,image/webp";

type ImageDraft = LabInfoSectionImage;
type ImageSaveResult =
  | { success: true; message: string }
  | { error: { message: string } };

function imageDraftKey(images: ImageDraft[]) {
  return JSON.stringify(
    images.map(({ id, caption, altText }) => ({ id, caption, altText }))
  );
}

export function LabInfoSectionEditor({
  section,
}: {
  section: LabInfoSectionView;
}) {
  const [draftTitle, setDraftTitle] = useState(section.title);
  const [draftText, setDraftText] = useState(section.text);
  const [showAddImage, setShowAddImage] = useState(false);
  const [imageDrafts, setImageDrafts] = useState<ImageDraft[]>(section.images);
  const [imageSaveFeedback, setImageSaveFeedback] = useState<string | null>(
    null
  );
  const imageFetcher = useFetcher<ImageSaveResult>();
  const imageIdsKey = section.images.map(({ id }) => id).join("\u0000");
  const savedImagesKey = imageDraftKey(section.images);
  const hasUnsavedImageChanges = imageDraftKey(imageDrafts) !== savedImagesKey;

  useEffect(() => {
    setShowAddImage(false);
  }, [section.images.length]);

  useEffect(() => {
    setImageDrafts((current) => {
      const availableIds = new Set(section.images.map(({ id }) => id));
      const existingIds = new Set(current.map(({ id }) => id));
      const retained = current.filter(({ id }) => availableIds.has(id));
      const added = section.images.filter(({ id }) => !existingIds.has(id));
      return [...retained, ...added];
    });
    setImageSaveFeedback(null);
  }, [imageIdsKey, section.images]);

  useEffect(() => {
    if (imageFetcher.state !== "idle" || !imageFetcher.data) return;
    setImageSaveFeedback(
      "success" in imageFetcher.data
        ? imageFetcher.data.message
        : imageFetcher.data.error.message
    );
  }, [imageFetcher.state, imageFetcher.data]);

  const updateImageDraft = (
    imageId: string,
    changes: Partial<Pick<ImageDraft, "caption" | "altText">>
  ) => {
    setImageDrafts((current) =>
      current.map((image) =>
        image.id === imageId ? { ...image, ...changes } : image
      )
    );
    setImageSaveFeedback(null);
  };

  const moveImageDraft = (index: number, direction: "up" | "down") => {
    setImageDrafts((current) => {
      const target = direction === "up" ? index - 1 : index + 1;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
    setImageSaveFeedback(null);
  };

  const saveImageDrafts = () => {
    const formData = new URLSearchParams();
    formData.set("intent", "save-images");
    formData.set("sectionKey", section.key);
    formData.set(
      "images",
      JSON.stringify(
        imageDrafts.map(({ id, caption, altText }) => ({
          id,
          caption: caption ?? "",
          altText: altText ?? "",
        }))
      )
    );
    void imageFetcher.submit(formData, { method: "post" });
    setImageSaveFeedback(null);
  };

  return (
    <div className="space-y-5">
      <Form method="post" className="space-y-3">
        <input type="hidden" name="intent" value="save-content" />
        <input type="hidden" name="sectionKey" value={section.key} />
        <section className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm sm:p-5">
          {section.isCustom ? (
            <label className="block text-sm font-semibold text-gray-900">
              Section title
              <input
                name="title"
                value={draftTitle}
                onChange={(event) => setDraftTitle(event.currentTarget.value)}
                required
                maxLength={120}
                className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm font-normal text-gray-900 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-200"
              />
            </label>
          ) : (
            <h2 className="text-lg font-semibold text-gray-900">
              {section.title}
            </h2>
          )}
          <label
            className="mt-4 block text-sm font-semibold text-gray-900"
            htmlFor={`lab-info-${section.key}`}
          >
            Content
          </label>
          <textarea
            id={`lab-info-${section.key}`}
            name="value"
            value={draftText}
            onChange={(event) => setDraftText(event.currentTarget.value)}
            rows={6}
            maxLength={5000}
            className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm font-normal text-gray-900 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-200"
          />
          <div className="mt-4 flex justify-end border-t border-gray-100 pt-3">
            <Button type="submit">Save {draftTitle}</Button>
          </div>
        </section>
      </Form>

      {!section.kind ? (
        <details className="group rounded-lg border border-gray-200 bg-white shadow-sm">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 sm:px-5">
            <span className="flex min-w-0 items-center gap-3">
              <span className="text-sm font-semibold text-gray-900">
                Images
              </span>
              <span className="text-xs text-gray-500">
                {section.images.length === 0
                  ? "No images"
                  : `${section.images.length} ${
                      section.images.length === 1 ? "image" : "images"
                    }`}
              </span>
            </span>
            <ChevronDown
              aria-hidden="true"
              className="size-4 shrink-0 text-gray-500 transition-transform group-open:rotate-180"
            />
          </summary>

          <div className="space-y-3 border-t border-gray-100 p-3 sm:p-4">
            {imageDrafts.map((image, index) => (
              <ImageRow
                key={image.id}
                image={
                  section.images.find(({ id }) => id === image.id) ?? image
                }
                draft={image}
                sectionKey={section.key}
                index={index}
                imageCount={imageDrafts.length}
                onCaptionChange={(caption) =>
                  updateImageDraft(image.id, { caption })
                }
                onAltTextChange={(altText) =>
                  updateImageDraft(image.id, { altText })
                }
                onMove={(direction) => moveImageDraft(index, direction)}
              />
            ))}

            {section.images.length < 8 ? (
              showAddImage ? (
                <AddImageForm
                  sectionKey={section.key}
                  onCancel={() => setShowAddImage(false)}
                />
              ) : null
            ) : null}

            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-gray-100 pt-3">
              {section.images.length >= 8 ? (
                <p className="mr-auto text-xs text-gray-500">
                  This section has reached the 8-image limit.
                </p>
              ) : null}
              {section.images.length < 8 && !showAddImage ? (
                <Button
                  type="button"
                  variant="secondary"
                  size="xs"
                  onClick={() => setShowAddImage(true)}
                >
                  + Add image
                </Button>
              ) : null}
              <div className="flex items-center gap-2">
                {imageSaveFeedback ? (
                  <p
                    role="status"
                    className={`text-xs ${
                      imageFetcher.data && "error" in imageFetcher.data
                        ? "text-error-600"
                        : "text-green-700"
                    }`}
                  >
                    {imageSaveFeedback}
                  </p>
                ) : null}
                <Button
                  type="button"
                  size="xs"
                  disabled={
                    !hasUnsavedImageChanges || imageFetcher.state !== "idle"
                  }
                  onClick={saveImageDrafts}
                >
                  {imageFetcher.state !== "idle" ? "Saving…" : "Save changes"}
                </Button>
              </div>
            </div>
          </div>
        </details>
      ) : null}

      <section aria-label={`${section.title} student preview`}>
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
          Student preview
        </p>
        <LabInfoContentSection
          title={draftTitle}
          text={draftText}
          images={section.images}
        />
      </section>
    </div>
  );
}

function ImageRow({
  image,
  draft,
  sectionKey,
  index,
  imageCount,
  onCaptionChange,
  onAltTextChange,
  onMove,
}: {
  image: LabInfoSectionImage;
  draft: ImageDraft;
  sectionKey: string;
  index: number;
  imageCount: number;
  onCaptionChange: (value: string) => void;
  onAltTextChange: (value: string) => void;
  onMove: (direction: "up" | "down") => void;
}) {
  return (
    <div className="grid grid-cols-[5rem_minmax(0,1fr)] gap-3 rounded-md border border-gray-200 p-2.5 sm:grid-cols-[7rem_minmax(0,1fr)] sm:gap-4 sm:p-3">
      <img
        src={image.url}
        alt={image.altText ?? ""}
        className="h-20 w-full rounded border border-gray-100 bg-gray-50 object-contain sm:h-24"
        loading="lazy"
      />

      <div className="min-w-0 space-y-2">
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="text-xs font-medium text-gray-700">
            Caption
            <input
              name="caption"
              value={draft.caption ?? ""}
              onChange={(event) => onCaptionChange(event.currentTarget.value)}
              maxLength={300}
              className="mt-1 block w-full rounded-md border border-gray-300 px-2.5 py-1.5 text-sm font-normal"
            />
          </label>
          <label className="text-xs font-medium text-gray-700">
            Accessibility text
            <input
              name="altText"
              value={draft.altText ?? ""}
              onChange={(event) => onAltTextChange(event.currentTarget.value)}
              maxLength={300}
              className="mt-1 block w-full rounded-md border border-gray-300 px-2.5 py-1.5 text-sm font-normal"
            />
          </label>
        </div>

        <div className="flex flex-wrap items-center gap-1.5 border-t border-gray-100 pt-2">
          <Button
            type="button"
            variant="secondary"
            size="xs"
            disabled={index === 0}
            onClick={() => onMove("up")}
          >
            Move up
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="xs"
            disabled={index === imageCount - 1}
            onClick={() => onMove("down")}
          >
            Move down
          </Button>
          <ReplaceImageForm image={image} sectionKey={sectionKey} />
          <ImageAction
            intent="remove-image"
            sectionKey={sectionKey}
            imageId={image.id}
            label="Remove"
            destructive
          />
        </div>
      </div>
    </div>
  );
}

function ReplaceImageForm({
  image,
  sectionKey,
}: {
  image: LabInfoSectionImage;
  sectionKey: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);

  useEffect(() => {
    setFile(null);
    if (inputRef.current) inputRef.current.value = "";
  }, [image.url]);

  const cancelSelection = () => {
    setFile(null);
    if (inputRef.current) inputRef.current.value = "";
  };

  return (
    <Form
      method="post"
      encType="multipart/form-data"
      className="flex flex-wrap items-center gap-2"
    >
      <input type="hidden" name="intent" value="replace-image" />
      <input type="hidden" name="sectionKey" value={sectionKey} />
      <input type="hidden" name="imageId" value={image.id} />
      <input
        ref={inputRef}
        type="file"
        name="image"
        accept={IMAGE_ACCEPT}
        required
        className="sr-only"
        aria-label="Choose replacement image"
        onChange={(event) => setFile(event.currentTarget.files?.[0] ?? null)}
      />
      {file ? (
        <>
          <div className="flex min-w-0 items-center gap-2">
            <FileThumbnail file={file} />
            <span className="max-w-48 break-all text-xs text-gray-600">
              {file.name}
            </span>
          </div>
          <Button
            type="button"
            variant="secondary"
            size="xs"
            onClick={cancelSelection}
          >
            Cancel
          </Button>
          <Button type="submit" variant="secondary" size="xs">
            Replace image
          </Button>
        </>
      ) : (
        <Button
          type="button"
          variant="secondary"
          size="xs"
          onClick={() => inputRef.current?.click()}
        >
          Replace
        </Button>
      )}
    </Form>
  );
}

function AddImageForm({
  sectionKey,
  onCancel,
}: {
  sectionKey: string;
  onCancel: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [isDragActive, setIsDragActive] = useState(false);

  const setSelectedFile = (selected: File | null) => {
    if (!selected || !inputRef.current) return;
    const transfer = new DataTransfer();
    transfer.items.add(selected);
    inputRef.current.files = transfer.files;
    setFile(selected);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragActive(false);
    const dropped = event.dataTransfer.files[0];
    if (dropped) setSelectedFile(dropped);
  };

  return (
    <Form
      method="post"
      encType="multipart/form-data"
      className="rounded-lg border border-gray-200 bg-white p-3 sm:p-4"
    >
      <input type="hidden" name="intent" value="add-image" />
      <input type="hidden" name="sectionKey" value={sectionKey} />
      <h3 className="mb-3 text-sm font-semibold text-gray-900">Add image</h3>
      <input
        ref={inputRef}
        type="file"
        name="image"
        accept={IMAGE_ACCEPT}
        className="sr-only"
        aria-label="Choose Lab Info image"
        onChange={(event) => setFile(event.currentTarget.files?.[0] ?? null)}
      />

      {file ? (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <FileThumbnail file={file} className="size-20" />
          <div className="min-w-0 flex-1">
            <p className="break-all text-sm font-medium text-gray-900">
              {file.name}
            </p>
            <Button
              type="button"
              variant="secondary"
              size="xs"
              className="mt-2"
              onClick={() => inputRef.current?.click()}
            >
              Change
            </Button>
          </div>
        </div>
      ) : (
        <div
          className={`flex flex-col items-center justify-center rounded-md border border-dashed px-3 py-6 text-center transition ${
            isDragActive
              ? "border-primary-500 bg-primary-50"
              : "border-gray-300 bg-gray-50"
          }`}
          onDragOver={(event) => {
            event.preventDefault();
            setIsDragActive(true);
          }}
          onDragLeave={() => setIsDragActive(false)}
          onDrop={handleDrop}
        >
          <p className="text-sm font-medium text-gray-900">
            Drop an image here
          </p>
          <p className="mt-1 text-xs text-gray-500">or</p>
          <Button
            type="button"
            variant="secondary"
            size="xs"
            className="mt-2"
            onClick={() => inputRef.current?.click()}
          >
            Choose image
          </Button>
          <p className="mt-3 text-xs text-gray-500">
            PNG, JPG or WebP · max 8 MB
          </p>
        </div>
      )}

      {file ? (
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="text-xs font-medium text-gray-700">
            Caption
            <input
              name="caption"
              maxLength={300}
              className="mt-1 block w-full rounded-md border border-gray-300 px-2.5 py-1.5 text-sm font-normal"
            />
          </label>
          <label className="text-xs font-medium text-gray-700">
            Accessibility text
            <input
              name="altText"
              maxLength={300}
              className="mt-1 block w-full rounded-md border border-gray-300 px-2.5 py-1.5 text-sm font-normal"
            />
          </label>
          <p className="text-xs text-gray-500 sm:col-span-2">
            Caption and accessibility text are optional.
          </p>
        </div>
      ) : null}

      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <Button type="button" variant="secondary" size="xs" onClick={onCancel}>
          Cancel
        </Button>
        {file ? (
          <Button type="submit" size="xs">
            Add image
          </Button>
        ) : null}
      </div>
    </Form>
  );
}

function FileThumbnail({
  file,
  className = "size-12",
}: {
  file: File;
  className?: string;
}) {
  const [previewUrl, setPreviewUrl] = useState("");

  useEffect(() => {
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  return (
    <div
      className={`flex ${className} shrink-0 items-center justify-center overflow-hidden rounded-md border border-gray-200 bg-gray-50 p-1`}
    >
      {previewUrl ? (
        <img
          src={previewUrl}
          alt={file.name}
          className="max-h-full max-w-full object-contain"
        />
      ) : null}
    </div>
  );
}

function ImageAction({
  intent,
  sectionKey,
  imageId,
  direction,
  disabled,
  label,
  destructive = false,
}: {
  intent: "move-image" | "remove-image";
  sectionKey: string;
  imageId: string;
  direction?: "up" | "down";
  disabled?: boolean;
  label: string;
  destructive?: boolean;
}) {
  return (
    <Form method="post">
      <input type="hidden" name="intent" value={intent} />
      <input type="hidden" name="sectionKey" value={sectionKey} />
      <input type="hidden" name="imageId" value={imageId} />
      {direction ? (
        <input type="hidden" name="direction" value={direction} />
      ) : null}
      <Button
        type="submit"
        variant={destructive ? "danger" : "secondary"}
        size="xs"
        disabled={disabled}
      >
        {label}
      </Button>
    </Form>
  );
}
