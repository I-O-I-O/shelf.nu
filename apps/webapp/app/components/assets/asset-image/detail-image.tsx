import { tw } from "~/utils/tw";
import { AssetImage } from "./component";
import type { AssetForPreview, AssetForThumbnail } from "./types";

export type AssetDetailImageProps =
  | {
      asset: AssetForPreview;
      alt: string;
      withPreview: true;
      className?: string;
      variant?: "detail" | "compact";
    }
  | {
      asset: AssetForThumbnail;
      alt: string;
      withPreview?: false;
      className?: string;
      variant?: "detail" | "compact";
    };

/**
 * Shelf-backed asset imagery for detail views. It resolves the same asset,
 * model, and placeholder cascade as AssetImage while fitting the original
 * image into its panel without cropping or excessive low-resolution scaling.
 */
export function AssetDetailImage(props: AssetDetailImageProps) {
  const variant = props.variant ?? "detail";
  const className = tw(
    variant === "detail"
      ? "flex min-h-0 w-full items-center justify-center p-2 sm:p-3"
      : "flex size-full min-h-0 items-center justify-center p-2 sm:p-3",
    props.className
  );

  if (props.withPreview) {
    return (
      <AssetImage
        asset={props.asset}
        alt={props.alt}
        withPreview
        useThumbnail={false}
        imageFit="contain"
        imageSizing={variant === "detail" ? "detail" : "natural"}
        className={className}
      />
    );
  }

  return (
    <AssetImage
      asset={props.asset}
      alt={props.alt}
      useThumbnail={false}
      imageFit="contain"
      imageSizing={variant === "detail" ? "detail" : "natural"}
      className={className}
    />
  );
}
