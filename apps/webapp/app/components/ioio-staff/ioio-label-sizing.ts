export type IoioLabelLayout = "section" | "horizontal";
export type IoioPrintSizeKey = "xxs" | "xs" | "s" | "m" | "l" | "xl" | "xxl";

export type IoioPrintDimensions = {
  widthMm: number;
  heightMm: number;
};

export function getIoioCloseUpPreviewSize(
  availableWidth: number,
  availableHeight: number,
  dimensions: IoioPrintDimensions,
  margin = 12
) {
  const width = Math.max(0, availableWidth - margin * 2);
  const height = Math.max(0, availableHeight - margin * 2);
  const scale = Math.min(
    width / dimensions.widthMm,
    height / dimensions.heightMm
  );

  if (!Number.isFinite(scale) || scale <= 0) {
    return { width: 0, height: 0 };
  }

  return {
    width: dimensions.widthMm * scale,
    height: dimensions.heightMm * scale,
  };
}

export const IOIO_PRINT_SIZE_ORDER: IoioPrintSizeKey[] = [
  "xxs",
  "xs",
  "s",
  "m",
  "l",
  "xl",
  "xxl",
];

export const IOIO_PRINT_SIZE_PRESETS: Array<{
  key: "s" | "m" | "l";
  label: string;
}> = [
  { key: "s", label: "S" },
  { key: "m", label: "M" },
  { key: "l", label: "L" },
];

type IoioLabelType =
  | "room"
  | "section"
  | "shelf"
  | "container"
  | "item"
  | "kit";

type IoioPrintPresetMap = Record<IoioPrintSizeKey, IoioPrintDimensions>;

export const IOIO_ROOM_PRINT_PRESETS: IoioPrintPresetMap = {
  xxs: { widthMm: 120, heightMm: 60 },
  xs: { widthMm: 160, heightMm: 75 },
  s: { widthMm: 200, heightMm: 90 },
  m: { widthMm: 240, heightMm: 110 },
  l: { widthMm: 280, heightMm: 130 },
  xl: { widthMm: 320, heightMm: 150 },
  xxl: { widthMm: 360, heightMm: 180 },
};

export const IOIO_SECTION_PRINT_PRESETS: IoioPrintPresetMap = {
  xxs: { widthMm: 80, heightMm: 110 },
  xs: { widthMm: 95, heightMm: 135 },
  s: { widthMm: 115, heightMm: 160 },
  m: { widthMm: 150, heightMm: 210 },
  l: { widthMm: 165, heightMm: 230 },
  xl: { widthMm: 180, heightMm: 255 },
  xxl: { widthMm: 195, heightMm: 280 },
};

export const IOIO_SHELF_PRINT_PRESETS: IoioPrintPresetMap = {
  xxs: { widthMm: 45, heightMm: 60 },
  xs: { widthMm: 60, heightMm: 80 },
  s: { widthMm: 75, heightMm: 100 },
  m: { widthMm: 90, heightMm: 120 },
  l: { widthMm: 105, heightMm: 140 },
  xl: { widthMm: 120, heightMm: 160 },
  xxl: { widthMm: 135, heightMm: 180 },
};

export const IOIO_BOX_PRINT_PRESETS: IoioPrintPresetMap = {
  xxs: { widthMm: 55, heightMm: 35 },
  xs: { widthMm: 65, heightMm: 40 },
  s: { widthMm: 75, heightMm: 46 },
  m: { widthMm: 90, heightMm: 55 },
  l: { widthMm: 105, heightMm: 65 },
  xl: { widthMm: 120, heightMm: 75 },
  xxl: { widthMm: 140, heightMm: 88 },
};

export const IOIO_KIT_PRINT_PRESETS: IoioPrintPresetMap = {
  xxs: { widthMm: 60, heightMm: 38 },
  xs: { widthMm: 75, heightMm: 46 },
  s: { widthMm: 90, heightMm: 55 },
  m: { widthMm: 105, heightMm: 64 },
  l: { widthMm: 120, heightMm: 74 },
  xl: { widthMm: 140, heightMm: 86 },
  xxl: { widthMm: 160, heightMm: 98 },
};

export const IOIO_ITEM_PRINT_PRESETS: IoioPrintPresetMap = {
  xxs: { widthMm: 35, heightMm: 20 },
  xs: { widthMm: 45, heightMm: 25 },
  s: { widthMm: 55, heightMm: 30 },
  m: { widthMm: 70, heightMm: 40 },
  l: { widthMm: 85, heightMm: 50 },
  xl: { widthMm: 100, heightMm: 60 },
  xxl: { widthMm: 120, heightMm: 70 },
};

const IOIO_PRINT_PRESETS_BY_TYPE: Record<IoioLabelType, IoioPrintPresetMap> = {
  room: IOIO_ROOM_PRINT_PRESETS,
  section: IOIO_SECTION_PRINT_PRESETS,
  shelf: IOIO_SHELF_PRINT_PRESETS,
  container: IOIO_BOX_PRINT_PRESETS,
  item: IOIO_ITEM_PRINT_PRESETS,
  kit: IOIO_KIT_PRINT_PRESETS,
};

export const IOIO_A4 = {
  widthMm: 210,
  heightMm: 297,
  gapMm: 6,
};

export const IOIO_SHELF_DEFAULT_DIMENSIONS = IOIO_SHELF_PRINT_PRESETS.m;

export function getIoioA4PreviewScale(dimensions: IoioPrintDimensions) {
  return {
    widthPercent: (dimensions.widthMm / IOIO_A4.widthMm) * 100,
    heightPercent: (dimensions.heightMm / IOIO_A4.heightMm) * 100,
    gapXPercent: (IOIO_A4.gapMm / IOIO_A4.widthMm) * 100,
    gapYPercent: (IOIO_A4.gapMm / IOIO_A4.heightMm) * 100,
  };
}

export function getIoioPrintDimensionsError(
  dimensions: Partial<IoioPrintDimensions>
) {
  const width = dimensions.widthMm;
  const height = dimensions.heightMm;

  if (
    typeof width !== "number" ||
    typeof height !== "number" ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return "Enter a valid label width and height.";
  }

  return null;
}

export function fitsIoioA4Portrait(dimensions: IoioPrintDimensions) {
  return (
    dimensions.widthMm <= IOIO_A4.widthMm &&
    dimensions.heightMm <= IOIO_A4.heightMm
  );
}

export function getIoioDefaultPrintSize(
  labelType: IoioLabelType
): IoioPrintSizeKey {
  if (labelType === "room") return "s";
  if (
    labelType === "section" ||
    labelType === "shelf" ||
    labelType === "container" ||
    labelType === "kit"
  ) {
    return "m";
  }
  return "s";
}

export function getIoioDefaultQrEnabled(labelType: IoioLabelType) {
  return (
    labelType === "container" || labelType === "kit" || labelType === "item"
  );
}

export function getIoioPrintDimensions(
  layout: IoioLabelLayout,
  key: IoioPrintSizeKey,
  labelType: IoioLabelType = layout === "section" ? "section" : "item"
): IoioPrintDimensions {
  return IOIO_PRINT_PRESETS_BY_TYPE[labelType][key];
}

export function getIoioA4Capacity(dimensions: IoioPrintDimensions) {
  if (!fitsIoioA4Portrait(dimensions)) {
    return { columns: 0, rows: 0, capacity: 0 };
  }

  const columns = Math.max(
    1,
    Math.floor(
      (IOIO_A4.widthMm + IOIO_A4.gapMm) / (dimensions.widthMm + IOIO_A4.gapMm)
    )
  );
  const rows = Math.max(
    1,
    Math.floor(
      (IOIO_A4.heightMm + IOIO_A4.gapMm) / (dimensions.heightMm + IOIO_A4.gapMm)
    )
  );
  return { columns, rows, capacity: columns * rows };
}

export function formatIoioDimension(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
