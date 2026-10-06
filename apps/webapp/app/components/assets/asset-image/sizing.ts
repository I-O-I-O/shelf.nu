export const ASSET_IMAGE_FRAME_CLASSES = {
  card: "mx-auto aspect-[4/3] max-h-[240px] max-w-[320px]",
  detail: "mx-auto h-[min(65vw,16rem)] w-full max-w-[440px] sm:h-64",
  thumbnail: "mx-auto aspect-square",
  instruction: "flex h-56 max-h-56 items-center justify-center",
} as const;

export type AssetImageFrameVariant = keyof typeof ASSET_IMAGE_FRAME_CLASSES;
