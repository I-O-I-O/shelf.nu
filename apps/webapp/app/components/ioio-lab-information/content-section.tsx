import { useState } from "react";
import { ZoomIn } from "lucide-react";
import { Dialog, DialogPortal } from "~/components/layout/dialog";
import { Button } from "~/components/shared/button";
import type { LabInfoSectionImage } from "~/modules/ioio-lab-information/sections.shared";

export function LabInfoText({ text }: { text: string }) {
  return (
    <div className="whitespace-pre-line text-sm leading-6 text-gray-700">
      {text}
    </div>
  );
}

export function LabInfoContentSection({
  title,
  text,
  images = [],
  showEmptyImagePlaceholder = false,
  showTitle = true,
}: {
  title: string;
  text: string;
  images?: LabInfoSectionImage[];
  showEmptyImagePlaceholder?: boolean;
  showTitle?: boolean;
}) {
  const hasSingleImage = images.length === 1;
  const hasGallery = images.length > 1;

  return (
    <section
      aria-label={title}
      className="w-full rounded-2xl border border-gray-200 bg-white p-5 text-left shadow-sm sm:p-6"
    >
      {showTitle ? (
        <h2 className="text-lg font-semibold text-gray-900">{title}</h2>
      ) : null}
      {hasSingleImage ? (
        <div
          className={`${
            showTitle ? "mt-3" : ""
          } grid items-start gap-5 md:grid-cols-[minmax(0,0.7fr)_minmax(0,1.3fr)]`}
        >
          <LabInfoFigure image={images[0]!} />
          <LabInfoText text={text} />
        </div>
      ) : (
        <div className={`${showTitle ? "mt-3" : ""} space-y-4`}>
          <LabInfoText text={text} />
          {showEmptyImagePlaceholder && images.length === 0 ? (
            <p className="rounded-md border border-dashed border-gray-300 px-3 py-2 text-xs text-gray-500">
              No image added. Images are optional.
            </p>
          ) : null}
          {hasGallery ? (
            <div
              className={`grid gap-3 ${
                images.length === 2
                  ? "grid-cols-2"
                  : "grid-cols-2 sm:grid-cols-3"
              }`}
            >
              {images.map((image) => (
                <LabInfoFigure key={image.id} image={image} compact />
              ))}
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}

function LabInfoFigure({
  image,
  compact = false,
}: {
  image: LabInfoSectionImage;
  compact?: boolean;
}) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <figure className="min-w-0">
      <div
        className={`flex items-center justify-center rounded-lg bg-gray-50 p-2 ${
          compact ? "h-44 sm:h-52" : "max-h-[26rem] min-h-40"
        }`}
      >
        <div className="relative flex size-full items-center justify-center">
          <button
            type="button"
            aria-label="View larger"
            onClick={() => setIsOpen(true)}
            className="flex size-full cursor-zoom-in items-center justify-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2"
          >
            <img
              src={image.url}
              alt={image.altText ?? ""}
              className={`size-auto max-w-full rounded-md object-contain ${
                compact ? "max-h-full" : "max-h-[25rem]"
              }`}
              loading="lazy"
            />
          </button>
          <button
            type="button"
            aria-label="View larger"
            title="View larger"
            onClick={() => setIsOpen(true)}
            className="absolute right-2 top-2 z-10 flex size-8 items-center justify-center rounded-full border border-white/80 bg-white/90 text-gray-800 shadow-sm backdrop-blur transition hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2"
          >
            <ZoomIn aria-hidden="true" className="size-4" />
          </button>
        </div>
      </div>
      {image.caption ? (
        <figcaption className="mt-1 text-xs leading-5 text-gray-600">
          {image.caption}
        </figcaption>
      ) : null}
      {isOpen ? (
        <DialogPortal>
          <Dialog
            open={isOpen}
            onClose={() => setIsOpen(false)}
            className="h-dvh w-full md:h-[calc(100vh-2rem)] md:w-[94vw] md:max-w-[94vw] md:py-0"
            title={
              <h2 className="py-2 text-base font-semibold text-gray-900">
                Image preview
              </h2>
            }
          >
            <div className="flex h-full min-h-0 flex-col items-center bg-gray-50 p-3 sm:p-5">
              <div className="flex min-h-0 w-full grow items-center justify-center">
                <img
                  src={image.url}
                  alt={image.altText ?? ""}
                  className="max-h-[calc(100dvh-10rem)] max-w-full object-contain md:max-h-[82vh]"
                />
              </div>
              {image.caption ? (
                <p className="max-h-20 w-full shrink-0 overflow-y-auto py-2 text-center text-sm text-gray-700">
                  {image.caption}
                </p>
              ) : null}
              <div className="flex w-full shrink-0 justify-end pt-2">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => setIsOpen(false)}
                >
                  Close
                </Button>
              </div>
            </div>
          </Dialog>
        </DialogPortal>
      ) : null}
    </figure>
  );
}
