import { IOIO_LOCATION_COLORS } from "~/components/location/ioio-location-colors";
import {
  createIoioQrMatrix,
  getIoioQrModulePitchMm,
  IOIO_QR_MIN_MODULE_MM,
  loadIoioQrLogoDataUrl,
  renderIoioBrandedQrContents,
} from "./ioio-branded-qr";
import {
  formatIoioDimension,
  getIoioDefaultPrintSize,
  getIoioPrintDimensions,
  type IoioPrintDimensions,
} from "./ioio-label-sizing";

export type IoioLabelData = {
  layout: "section" | "horizontal";
  variant?: "location" | "room" | "section" | "shelf" | "box" | "item" | "kit";
  color: string;
  colorName: string;
  code: string;
  title: string;
  subtitle: string;
  customText?: string;
  unitNumber?: string | null;
  room: string;
  headerMeta?: string;
  headerRightText?: string;
  scanText: string;
  qrValue?: string;
  showTypeLabel?: boolean;
};

export function getIoioLocationPathIdentifier(
  path: Array<{ name: string }>
): string | null {
  const section = path[1];
  if (!section) return null;

  const sectionIdentifier = getIoioLocationIdentifier(section.name, "section");
  const shelf = path[2];
  if (!shelf) return sectionIdentifier;

  const shelfIdentifier = getIoioLocationIdentifier(
    shelf.name,
    "shelf",
    sectionIdentifier
  );
  const container = path[3];
  return container
    ? getIoioLocationIdentifier(container.name, "box", shelfIdentifier)
    : shelfIdentifier;
}

export const IOIO_LABEL_COLORS = IOIO_LOCATION_COLORS.map(
  ({ color, name }) => ({ color, name })
);

export const IOIO_LABEL_CUSTOM_TEXT_MAX_LENGTH = 32;

export function normalizeIoioCustomLabelText(value: string) {
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return [...normalized]
    .slice(0, IOIO_LABEL_CUSTOM_TEXT_MAX_LENGTH)
    .join("")
    .trimEnd();
}

export function normalizeIoioLabelText(value: string) {
  return value.replace(/[\u2010-\u2015\u2212]/gu, "-");
}

export function getIoioLabelColor(value: string) {
  const knownColor = IOIO_LABEL_COLORS.find(
    (entry) => entry.color.toLowerCase() === value.trim().toLowerCase()
  );
  if (knownColor) return knownColor;
  const letter = value.match(/(?:^|\s)([A-Z])(?:\d|$)/iu)?.[1]?.toUpperCase();
  if (letter) {
    return IOIO_LABEL_COLORS[
      (letter.charCodeAt(0) - 65) % IOIO_LABEL_COLORS.length
    ];
  }
  const hash = [...value].reduce(
    (result, character) => result + character.charCodeAt(0),
    0
  );
  return IOIO_LABEL_COLORS[hash % IOIO_LABEL_COLORS.length];
}

function escapeSvg(value: string, normalizeDashes = true) {
  return (normalizeDashes ? normalizeIoioLabelText(value) : value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function getDefaultLabelDimensions(label: IoioLabelData) {
  const type =
    label.variant === "location"
      ? label.layout === "section"
        ? "section"
        : "room"
      : label.variant ?? (label.layout === "section" ? "section" : "item");
  const labelType = type === "box" ? "container" : type;
  return getIoioPrintDimensions(
    label.layout,
    getIoioDefaultPrintSize(labelType),
    labelType
  );
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function svgNumber(value: number) {
  return Number(value.toFixed(2));
}

function glyphWidthRatio(character: string) {
  if (/\s/u.test(character)) return 0.34;
  if (/[ilI.,:;!'|`]/u.test(character)) return 0.36;
  if (/[MW@%&]/u.test(character)) return 0.96;
  if (/[A-Z0-9]/u.test(character)) return 0.72;
  return 0.64;
}

function measuredSvgTextWidth(value: string, fontSize: number) {
  return [...value].reduce(
    (width, character) => width + glyphWidthRatio(character) * fontSize,
    0
  );
}

function truncateSvgText(value: string, maxWidth: number, fontSize: number) {
  const suffix = "…";
  if (measuredSvgTextWidth(suffix, fontSize) > maxWidth) return "";
  const characters = [...value];
  while (
    characters.length > 0 &&
    measuredSvgTextWidth(
      `${characters.join("").trimEnd()}${suffix}`,
      fontSize
    ) > maxWidth
  ) {
    characters.pop();
  }
  return `${characters.join("").trimEnd()}${suffix}`;
}

function wrapSvgText(
  value: string,
  maxWidth: number,
  fontSize: number,
  maxLines: number
) {
  const lines: string[] = [];
  const words = value.trim().split(/\s+/u).filter(Boolean);
  let line = "";

  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (measuredSvgTextWidth(candidate, fontSize) <= maxWidth) {
      line = candidate;
      continue;
    }

    if (line) lines.push(line);
    line = "";

    line =
      measuredSvgTextWidth(word, fontSize) <= maxWidth
        ? word
        : truncateSvgText(word, maxWidth, fontSize);
  }

  if (line) lines.push(line);
  const fittedLines = lines
    .map((entry) =>
      measuredSvgTextWidth(entry, fontSize) <= maxWidth
        ? entry
        : truncateSvgText(entry, maxWidth, fontSize)
    )
    .filter(Boolean);
  if (fittedLines.length <= maxLines) return fittedLines;

  const visibleLines = fittedLines.slice(0, maxLines);
  visibleLines[maxLines - 1] = truncateSvgText(
    visibleLines[maxLines - 1],
    maxWidth,
    fontSize
  );
  return visibleLines;
}

function wrapSvgTextWithoutEllipsis(
  value: string,
  maxWidth: number,
  fontSize: number
) {
  const lines: string[] = [];
  let line = "";

  for (const word of value.trim().split(/\s+/u).filter(Boolean)) {
    const candidate = line ? `${line} ${word}` : word;
    if (measuredSvgTextWidth(candidate, fontSize) <= maxWidth) {
      line = candidate;
      continue;
    }

    if (line) lines.push(line);
    line = word;
  }

  if (line) lines.push(line);
  return lines;
}

export function getIoioLocationIdentifier(
  name: string,
  level: "section" | "shelf" | "box",
  parentIdentifier?: string
) {
  const withoutType = name
    .trim()
    .replace(/^(?:section|shelf|container|box)\s+/iu, "");
  const token = withoutType.match(
    /^([A-Z]\d*(?:-\d+)*|\d+(?:-\d+)*)(?=$|\s|[-:])/iu
  )?.[1];
  const ownIdentifier = (token ?? withoutType).trim().toUpperCase();

  if (
    level === "shelf" &&
    parentIdentifier &&
    /^\d+[A-Z]?$/iu.test(ownIdentifier)
  ) {
    const separator = /\d$/u.test(parentIdentifier) ? "-" : "";
    return `${parentIdentifier}${separator}${ownIdentifier}`;
  }

  if (
    level === "box" &&
    parentIdentifier &&
    /^\d+[A-Z]?$/iu.test(ownIdentifier)
  ) {
    return `${parentIdentifier}-${ownIdentifier}`;
  }

  return ownIdentifier;
}

function renderSvgTextBlock({
  value,
  lines: fittedLines,
  x,
  y,
  width,
  height,
  fontSize,
  maxLines,
  fill,
  fontWeight,
  textAnchor = "start",
  normalizeDashes = true,
}: {
  value: string;
  lines?: string[];
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
  maxLines: number;
  fill: string;
  fontWeight: number;
  textAnchor?: "start" | "middle" | "end";
  normalizeDashes?: boolean;
}) {
  if (!value.trim() || width <= 0 || height <= 0) return "";

  const lines = fittedLines ?? wrapSvgText(value, width, fontSize, maxLines);
  if (!lines.length) return "";
  const lineHeight = fontSize * 1.08;
  const textHeight = fontSize + (lines.length - 1) * lineHeight;
  const firstBaseline = y + (height - textHeight) / 2 + fontSize * 0.82;
  const tspans = lines
    .map(
      (line, index) =>
        `<tspan x="${svgNumber(x)}" y="${svgNumber(
          firstBaseline + index * lineHeight
        )}">${escapeSvg(line, normalizeDashes)}</tspan>`
    )
    .join("");

  return `<text x="${svgNumber(x)}" y="${svgNumber(
    firstBaseline
  )}" text-anchor="${textAnchor}" font-family="Arial, Helvetica, sans-serif" font-size="${svgNumber(
    fontSize
  )}" font-weight="${fontWeight}" fill="${fill}">${tspans}</text>`;
}

function renderCustomLabelCaption(
  value: string | undefined,
  x: number,
  y: number,
  width: number,
  height: number,
  fill = "#667085"
) {
  const text = value?.trim();
  if (!text || width <= 0 || height <= 0) return "";

  const fontSize = clamp(height * 0.42, 1.8, 3.6);
  const fittedText =
    measuredSvgTextWidth(text, fontSize) > width
      ? truncateSvgText(text, width, fontSize)
      : text;
  return renderSvgTextBlock({
    value: fittedText,
    lines: [fittedText],
    x: x + width / 2,
    y,
    width,
    height,
    fontSize,
    maxLines: 1,
    fill,
    fontWeight: 500,
    textAnchor: "middle",
    normalizeDashes: false,
  });
}

function fitSvgText(
  value: string,
  width: number,
  height: number,
  preferredFontSize: number,
  maxLines: number
) {
  let fontSize = preferredFontSize;
  const longestWordRatio = Math.max(
    0,
    ...value
      .trim()
      .split(/\s+/u)
      .map((word) => measuredSvgTextWidth(word, 1))
  );
  const minFontSize = Math.max(
    1.25,
    Math.min(
      preferredFontSize * 0.55,
      longestWordRatio ? width / longestWordRatio : preferredFontSize * 0.55,
      height / (1 + Math.max(0, maxLines - 1) * 1.08)
    )
  );
  let lines = wrapSvgText(value, width, fontSize, maxLines);
  for (let pass = 0; pass < 18; pass += 1) {
    const textHeight =
      fontSize + Math.max(0, lines.length - 1) * fontSize * 1.08;
    const longestWordWidth = Math.max(
      0,
      ...value
        .trim()
        .split(/\s+/u)
        .map((word) => measuredSvgTextWidth(word, fontSize))
    );
    if (
      (textHeight <= height && longestWordWidth <= width) ||
      fontSize <= minFontSize
    ) {
      break;
    }
    fontSize = Math.max(minFontSize, fontSize * 0.88);
    lines = wrapSvgText(value, width, fontSize, maxLines);
  }
  return { fontSize, lines };
}

function fitLocationLabelText(
  value: string,
  width: number,
  height: number,
  preferredFontSize: number,
  maxLines: number
) {
  const getLayout = (fontSize: number) => {
    const lines = wrapSvgTextWithoutEllipsis(value, width, fontSize);
    const textHeight =
      fontSize + Math.max(0, lines.length - 1) * fontSize * 1.08;
    const fits =
      lines.length <= maxLines &&
      textHeight <= height &&
      lines.every((line) => measuredSvgTextWidth(line, fontSize) <= width);
    return { fontSize, lines, fits };
  };

  const preferred = getLayout(preferredFontSize);
  if (preferred.fits) return preferred;

  let smallest = getLayout(1.25);
  if (!smallest.fits) {
    return fitSvgText(value, width, height, preferredFontSize, maxLines);
  }

  let low = smallest.fontSize;
  let high = preferredFontSize;
  for (let pass = 0; pass < 20; pass += 1) {
    const middle = (low + high) / 2;
    const candidate = getLayout(middle);
    if (candidate.fits) {
      smallest = candidate;
      low = middle;
    } else {
      high = middle;
    }
  }

  return smallest;
}

function renderKitTextBlock(
  label: IoioLabelData,
  x: number,
  y: number,
  width: number,
  height: number,
  color: string
) {
  const caption = label.customText?.trim();
  const captionHeight = caption ? clamp(height * 0.13, 4, 8) : 0;
  const contentHeightArea = Math.max(1, height - captionHeight);
  const unitNumber = label.unitNumber?.trim() ?? "";
  const inset = clamp(width * 0.035, 1, 2);
  const textWidth = Math.max(1, width - inset * 2);
  const nameTextWidth = Math.max(1, width - inset);
  const gap = clamp(contentHeightArea * 0.025, 0.8, 1.5);
  const unitAreaHeight = unitNumber ? clamp(contentHeightArea * 0.2, 5, 8) : 0;
  const nameAreaHeight = Math.max(
    1,
    contentHeightArea - unitAreaHeight - (unitNumber ? gap : 0)
  );
  const preferredTitleSize = Math.min(
    nameAreaHeight * 0.48,
    nameTextWidth * 0.13
  );
  const titleValue = label.title.trim();
  const oneLineTitleSize = Math.min(
    preferredTitleSize,
    (nameTextWidth * 0.97) / Math.max(1, measuredSvgTextWidth(titleValue, 1))
  );
  const useOneLineTitle =
    oneLineTitleSize >= preferredTitleSize * 0.7 && oneLineTitleSize >= 3;
  let wrappedTitleSize = preferredTitleSize;
  let wrappedTitleLines = wrapSvgText(
    titleValue,
    nameTextWidth,
    wrappedTitleSize,
    2
  );
  const minimumWrappedTitleSize = Math.max(1.25, preferredTitleSize * 0.55);
  while (
    wrappedTitleLines.join(" ") !== titleValue &&
    wrappedTitleSize > minimumWrappedTitleSize
  ) {
    wrappedTitleSize = Math.max(
      minimumWrappedTitleSize,
      wrappedTitleSize * 0.92
    );
    wrappedTitleLines = wrapSvgText(
      titleValue,
      nameTextWidth,
      wrappedTitleSize,
      2
    );
  }
  const titleFit = useOneLineTitle
    ? { fontSize: oneLineTitleSize, lines: [titleValue] }
    : wrappedTitleLines.join(" ") === titleValue
    ? { fontSize: wrappedTitleSize, lines: wrappedTitleLines }
    : fitSvgText(
        titleValue,
        nameTextWidth,
        nameAreaHeight,
        preferredTitleSize,
        2
      );
  const titleHeight =
    titleFit.fontSize +
    Math.max(0, titleFit.lines.length - 1) * titleFit.fontSize * 1.08;
  const renderedTitleFontSize =
    titleFit.fontSize * (titleFit.lines.length === 1 ? 0.95 : 1);
  const unitFit = unitNumber
    ? fitSvgText(
        unitNumber,
        textWidth,
        unitAreaHeight,
        Math.min(unitAreaHeight * 0.72, textWidth * 0.18),
        1
      )
    : null;
  const unitHeight = unitFit?.fontSize ?? 0;
  const contentHeight = titleHeight + (unitFit ? gap + unitHeight : 0);
  let rowY = y + Math.max(0, (contentHeightArea - contentHeight) / 2);

  const title = renderSvgTextBlock({
    value: titleValue,
    lines: titleFit.lines,
    x: x + inset,
    y: rowY,
    width: nameTextWidth,
    height: titleHeight,
    fontSize: renderedTitleFontSize,
    maxLines: 2,
    fill: "#0c162d",
    fontWeight: 800,
  });
  rowY += titleHeight;

  const unit = unitFit
    ? renderSvgTextBlock({
        value: unitNumber,
        x: x + inset,
        y: rowY + gap,
        width: textWidth,
        height: unitHeight,
        fontSize: unitFit.fontSize,
        maxLines: 1,
        fill: color,
        fontWeight: 800,
      })
    : "";
  const customCaption = renderCustomLabelCaption(
    caption,
    x + inset,
    y + contentHeightArea,
    textWidth,
    captionHeight
  );
  return `${title}${unit}${customCaption}`;
}

function getQrSizing(variant: NonNullable<IoioLabelData["variant"]>) {
  switch (variant) {
    case "room":
      return { ratio: 0.15, min: 12, max: 26 };
    case "section":
      return { ratio: 0.185, min: 14, max: 26 };
    case "shelf":
      return { ratio: 0.16, min: 14, max: 24 };
    case "box":
      return { ratio: 0.32, min: 14, max: 40 };
    case "kit":
      return { ratio: 0.33, min: 16, max: 44 };
    case "item":
      return { ratio: 0.35, min: 12, max: 50 };
    case "location":
      return { ratio: 0.2, min: 14, max: 32 };
  }
  return { ratio: 0.2, min: 14, max: 32 };
}

function getQrSizeForLabel(
  width: number,
  height: number,
  variant: NonNullable<IoioLabelData["variant"]>
) {
  const preference = getQrSizing(variant);
  const isLocationLayout =
    variant === "section" || variant === "shelf" || variant === "room";
  let maxHeight: number;
  let maxWidth: number;

  if (isLocationLayout) {
    const headerHeight = clamp(height * 0.1, 18, 26);
    maxHeight = headerHeight - 0.2;
    maxWidth =
      width * (variant === "section" || variant === "shelf" ? 0.2 : 0.16);
  } else {
    const padding = clamp(Math.min(width, height) * 0.055, 2, 6);
    const headerHeight = clamp(height * 0.19, 7, 15);
    const bodyTop = headerHeight + padding * 0.4;
    const bodyHeight = height - bodyTop - padding;
    const gap = clamp(width * 0.045, 3, 7);
    maxHeight = bodyHeight * 0.99;
    maxWidth = width - padding * 2 - gap;
  }

  return Math.min(
    clamp(width * preference.ratio, preference.min, preference.max),
    maxHeight,
    maxWidth
  );
}

/** Returns a visible print-blocking reason when a real QR cannot fit safely. */
export function getIoioLabelQrError(
  label: IoioLabelData,
  size?: IoioPrintDimensions
) {
  const variant =
    label.variant ?? (label.layout === "section" ? "section" : "item");

  if (variant === "section" || variant === "shelf") {
    return label.qrValue?.trim()
      ? "QR codes are not available for Sections or Shelves. Choose a Container or an inventory item instead."
      : null;
  }

  if (!label.qrValue?.trim()) {
    return "A real QR payload is missing for one or more selected labels. Select an item with an active QR code, or turn off Include QR.";
  }

  const dimensions = size ?? getDefaultLabelDimensions(label);

  try {
    const matrix = createIoioQrMatrix(label.qrValue);
    const qrBlockSize = getQrSizeForLabel(
      dimensions.widthMm,
      dimensions.heightMm,
      variant
    );
    const modulePitch = getIoioQrModulePitchMm(qrBlockSize, matrix.moduleCount);

    if (modulePitch < IOIO_QR_MIN_MODULE_MM) {
      return `This ${formatIoioDimension(
        dimensions.widthMm
      )} × ${formatIoioDimension(
        dimensions.heightMm
      )} mm label cannot fit a scannable QR code at a safe printed module size. Choose a larger label, or turn off Include QR.`;
    }
  } catch {
    return "The QR code could not be generated from this label’s payload. Check that the selected item has an active QR code.";
  }

  return null;
}

/** Preview and print share this single millimeter-coordinate SVG renderer. */
export function renderIoioLabelSvgMarkup(
  label: IoioLabelData,
  size?: IoioPrintDimensions,
  options: { logoHref?: string } = {}
) {
  const dimensions = size ?? getDefaultLabelDimensions(label);
  const width = dimensions.widthMm;
  const height = dimensions.heightMm;
  const physicalWidth = `${formatIoioDimension(width)}mm`;
  const physicalHeight = `${formatIoioDimension(height)}mm`;
  const color = escapeSvg(label.color);
  const variant =
    label.variant ?? (label.layout === "section" ? "section" : "item");
  const qrMatrix =
    label.qrValue && variant !== "section" && variant !== "shelf"
      ? createIoioQrMatrix(label.qrValue)
      : null;
  const customText = label.customText?.trim() ?? "";
  const titleText = escapeSvg(label.title, variant !== "kit");
  const unitText = label.unitNumber ? ` ${escapeSvg(label.unitNumber)}` : "";
  const qrSizeValue = () =>
    qrMatrix ? getQrSizeForLabel(width, height, variant) : 0;

  const svgStart = `<svg xmlns="http://www.w3.org/2000/svg" width="${physicalWidth}" height="${physicalHeight}" viewBox="0 0 ${svgNumber(
    width
  )} ${svgNumber(
    height
  )}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${titleText}${unitText}">`;
  if (width < 6 || height < 6) return `${svgStart}</svg>`;
  const qrImage = (x: number, y: number, qrSize: number) =>
    qrMatrix && qrSize > 0
      ? renderIoioBrandedQrContents(
          qrMatrix,
          label.qrValue!,
          x,
          y,
          qrSize,
          options.logoHref
        )
      : "";

  if (variant === "section" || variant === "shelf" || variant === "room") {
    const padding = clamp(width * 0.055, 3, 12);
    const headerHeight = clamp(height * 0.1, 18, 26);
    const showTypeLabel = label.showTypeLabel !== false;
    const footerHeight = showTypeLabel
      ? variant === "shelf"
        ? clamp(height * 0.14, 9, 24)
        : clamp(height * 0.12, 16, 30)
      : 0;
    const hasFooterBand =
      showTypeLabel && (variant === "section" || variant === "shelf");
    const qrSize = qrSizeValue();
    const qrX = width - padding - qrSize;
    const qrY = (headerHeight - qrSize) / 2;
    const headerGap = qrSize ? clamp(width * 0.025, 3, 8) : 0;
    const headerText =
      label.headerMeta || label.room || "Location not recorded";
    const headerWidth = width - padding * 2 - qrSize - headerGap;
    const headerFont = fitSvgText(
      headerText,
      headerWidth,
      headerHeight - 4,
      clamp(width * 0.052, 4, 8),
      3
    );
    const mainText =
      variant === "room" ? label.title || label.code : label.code;
    const mainY = headerHeight + padding * 0.3;
    const captionHeight = customText ? clamp(height * 0.06, 5, 9) : 0;
    const mainHeight =
      height - headerHeight - footerHeight - padding * 0.7 - captionHeight;
    const mainWidth = width - padding * 2;
    const mainFont = fitLocationLabelText(
      mainText,
      mainWidth,
      mainHeight * 0.92,
      mainHeight *
        (variant === "section" ? 0.82 : variant === "shelf" ? 0.72 : 0.84),
      2
    );
    const mainTextHeight =
      mainFont.fontSize +
      Math.max(0, mainFont.lines.length - 1) * mainFont.fontSize * 1.08;
    const footerText = showTypeLabel
      ? variant === "room"
        ? "ROOM"
        : variant === "section"
        ? "SECTION"
        : "SHELF"
      : "";
    const footerFont = fitSvgText(
      footerText,
      mainWidth,
      footerHeight * 0.72,
      footerHeight * (hasFooterBand ? 0.56 : 0.5),
      1
    );
    const footerTextY = hasFooterBand
      ? height - footerHeight + 0.35
      : height - footerHeight;
    const footerTextHeight = hasFooterBand
      ? footerHeight - 2.7
      : footerHeight * 0.78;
    const footerBorderInset = 0.85;
    const footerBorderRadius = 1.65;
    const footerBorderBottom = height - footerBorderInset;
    const footerBorderSideBottom = footerBorderBottom - footerBorderRadius;

    return `${svgStart}
      <rect x="0.5" y="0.5" width="${svgNumber(width - 1)}" height="${svgNumber(
        height - 1
      )}" rx="2" fill="${color}"/>
      <rect x="2" y="2" width="${svgNumber(width - 4)}" height="${svgNumber(
        height - 4
      )}" rx="1" fill="none" stroke="#ffffff" stroke-opacity="0.28" stroke-width="0.7"/>
      ${
        hasFooterBand
          ? `<rect x="0" y="${svgNumber(
              height - footerHeight
            )}" width="${svgNumber(width)}" height="${svgNumber(
              footerHeight
            )}" fill="#ffffff"/><path d="M${svgNumber(
              footerBorderInset
            )} ${svgNumber(height - footerHeight)}H${svgNumber(
              width - footerBorderInset
            )}V${svgNumber(footerBorderSideBottom)}Q${svgNumber(
              width - footerBorderInset
            )} ${svgNumber(footerBorderBottom)} ${svgNumber(
              width - footerBorderInset - footerBorderRadius
            )} ${svgNumber(footerBorderBottom)}H${svgNumber(
              footerBorderInset + footerBorderRadius
            )}Q${svgNumber(footerBorderInset)} ${svgNumber(
              footerBorderBottom
            )} ${svgNumber(footerBorderInset)} ${svgNumber(
              footerBorderSideBottom
            )}Z" fill="none" stroke="${color}" stroke-width="0.9"/>`
          : ""
      }
      ${renderSvgTextBlock({
        value: headerText,
        x: padding,
        y: 2,
        width: Math.max(1, headerWidth),
        height: headerHeight - 4,
        fontSize: headerFont.fontSize,
        maxLines: 3,
        fill: "#ffffff",
        fontWeight: 700,
        normalizeDashes: false,
      })}
      ${qrImage(qrX, qrY, qrSize)}
      ${renderSvgTextBlock({
        value: mainText,
        lines: mainFont.lines,
        x: width / 2,
        y: mainY + (mainHeight - mainTextHeight) / 2,
        width: mainWidth,
        height: mainTextHeight,
        fontSize: mainFont.fontSize,
        maxLines: 2,
        fill: "#ffffff",
        fontWeight: 900,
        textAnchor: "middle",
      })}
      ${renderCustomLabelCaption(
        customText,
        padding,
        height - footerHeight - captionHeight,
        mainWidth,
        captionHeight,
        "#ffffff"
      )}
      ${renderSvgTextBlock({
        value: footerText,
        x: width / 2,
        y: footerTextY,
        width: mainWidth,
        height: footerTextHeight,
        fontSize: footerFont.fontSize,
        maxLines: 1,
        fill: hasFooterBand ? color : "#ffffff",
        fontWeight: 800,
        textAnchor: "middle",
      })}
    </svg>`;
  }

  const padding = clamp(Math.min(width, height) * 0.055, 2, 6);
  const headerHeight = clamp(height * 0.19, 7, 15);
  const bodyTop = headerHeight + padding * 0.4;
  const bodyHeight = height - bodyTop - padding;
  const gap = clamp(width * 0.045, 3, 7);
  const qrSize = qrSizeValue();
  const qrX = width - padding - qrSize;
  const qrY = bodyTop + (bodyHeight - qrSize) / 2;
  const textWidth = Math.max(
    1,
    width - padding * 2 - qrSize - (qrSize ? gap : 0)
  );
  const headerText = label.headerMeta || label.room || "Location not recorded";
  const headerRightText =
    variant === "kit" && label.showTypeLabel !== false
      ? label.headerRightText || "KIT"
      : "";
  const headerFontSize = clamp(width * 0.045, 3, 6);
  const headerRightWidth = headerRightText
    ? measuredSvgTextWidth(headerRightText, headerFontSize) + padding * 0.6
    : 0;
  const headerGap = headerRightText ? padding * 0.6 : 0;
  const headerLeftWidth = Math.max(
    1,
    width - padding * 2 - headerRightWidth - headerGap
  );
  const headerFit = fitSvgText(
    headerText,
    headerLeftWidth,
    headerHeight - 2,
    headerFontSize,
    1
  );

  let primaryText = label.code;
  let secondaryText = label.title;
  if (variant === "kit") {
    primaryText = "";
    secondaryText = "";
  } else if (variant === "box") {
    primaryText = label.code;
    secondaryText = label.showTypeLabel === false ? "" : "CONTAINER";
  } else if (variant === "item") {
    const unitNumber = label.title.match(/(?:^|\s)(#\d+)\s*$/u)?.[1];
    if (unitNumber) {
      primaryText = unitNumber;
      secondaryText = label.title.replace(/\s*#\d+\s*$/u, "").trim();
    } else {
      primaryText = label.title;
      secondaryText = label.subtitle || "ITEM";
    }
  }

  const captionHeight = customText ? clamp(bodyHeight * 0.16, 4, 8) : 0;
  const contentBodyHeight = Math.max(1, bodyHeight - captionHeight);
  const primaryAreaHeight =
    contentBodyHeight *
    (secondaryText ? (variant === "item" ? 0.5 : 0.62) : 0.76);
  const secondaryAreaHeight = secondaryText
    ? contentBodyHeight * (variant === "item" ? 0.34 : 0.18)
    : 0;
  const primaryFont = fitSvgText(
    primaryText,
    textWidth,
    primaryAreaHeight,
    bodyHeight * 0.64,
    2
  );
  const primaryHeight =
    primaryFont.fontSize +
    Math.max(0, primaryFont.lines.length - 1) * primaryFont.fontSize * 1.08;
  const secondaryFont = secondaryText
    ? fitSvgText(
        secondaryText,
        textWidth,
        secondaryAreaHeight,
        clamp(height * 0.105, 3, 6),
        variant === "item" ? 2 : 1
      )
    : null;
  const secondaryHeight = secondaryFont
    ? secondaryFont.fontSize +
      Math.max(0, secondaryFont.lines.length - 1) *
        secondaryFont.fontSize *
        1.08
    : 0;
  const textGap = secondaryText ? clamp(height * 0.02, 1.2, 2) : 0;
  const textHeight = primaryHeight + textGap + secondaryHeight;
  const textY = bodyTop + Math.max(0, (contentBodyHeight - textHeight) / 2);
  const divider = qrSize
    ? `<path d="M${svgNumber(qrX - gap / 2)} ${svgNumber(bodyTop)}V${svgNumber(
        bodyTop + bodyHeight
      )}" fill="none" stroke="#d8dde5" stroke-width="0.7"/>`
    : "";

  return `${svgStart}
    <rect x="0.5" y="0.5" width="${svgNumber(width - 1)}" height="${svgNumber(
      height - 1
    )}" rx="2" fill="#ffffff" stroke="${color}" stroke-width="1"/>
    <path d="M2 0.5H${svgNumber(width - 2)}Q${svgNumber(
      width - 0.5
    )} 0.5 ${svgNumber(width - 0.5)} 2V${svgNumber(
      headerHeight
    )}H0.5V2Q0.5 0.5 2 0.5Z" fill="${color}"/>
    ${renderSvgTextBlock({
      value: headerText,
      x: padding,
      y: 1,
      width: headerLeftWidth,
      height: headerHeight - 2,
      fontSize: headerFit.fontSize,
      maxLines: 1,
      fill: "#ffffff",
      fontWeight: 700,
      normalizeDashes: false,
    })}
    ${
      headerRightText
        ? renderSvgTextBlock({
            value: headerRightText,
            x: width - padding,
            y: 1,
            width: headerRightWidth,
            height: headerHeight - 2,
            fontSize: headerFontSize,
            maxLines: 1,
            fill: "#ffffff",
            fontWeight: 800,
            textAnchor: "end",
            normalizeDashes: false,
          })
        : ""
    }
    ${divider}
    ${
      variant === "kit"
        ? renderKitTextBlock(
            label,
            padding,
            bodyTop,
            textWidth,
            bodyHeight,
            color
          )
        : renderSvgTextBlock({
            value: primaryText,
            x: padding + textWidth / 2,
            y: textY,
            width: textWidth,
            height: primaryHeight,
            fontSize: primaryFont.fontSize,
            maxLines: 2,
            fill: "#0c162d",
            fontWeight: 900,
            textAnchor: "middle",
          })
    }
    ${
      secondaryFont && variant !== "kit"
        ? renderSvgTextBlock({
            value: secondaryText,
            x: padding + textWidth / 2,
            y: textY + primaryHeight + textGap,
            width: textWidth,
            height: secondaryHeight,
            fontSize: secondaryFont.fontSize,
            maxLines: variant === "item" ? 2 : 1,
            fill: color,
            fontWeight: 800,
            textAnchor: "middle",
          })
        : ""
    }
    ${
      variant !== "kit"
        ? renderCustomLabelCaption(
            customText,
            padding,
            bodyTop + contentBodyHeight,
            textWidth,
            captionHeight
          )
        : ""
    }
    ${qrImage(qrX, qrY, qrSize)}
  </svg>`;
}

export function IoioLabelPreview({
  label,
  size,
  logoHref,
  logoError,
}: {
  label: IoioLabelData;
  size?: IoioPrintDimensions;
  logoHref?: string;
  logoError?: string | null;
}) {
  const qrError =
    label.qrValue !== undefined ? getIoioLabelQrError(label, size) : null;
  if (qrError) {
    return (
      <div
        className="ioio-label-qr-error"
        role="alert"
        aria-label="Label QR error"
      >
        {qrError}
      </div>
    );
  }

  if (label.qrValue && !logoHref) {
    return (
      <div
        className="ioio-label-qr-error"
        role={logoError ? "alert" : "status"}
        aria-label="IOIO logo loading status"
      >
        {logoError ?? "Loading IOIO label branding…"}
      </div>
    );
  }

  let markup: string;
  try {
    markup = renderIoioLabelSvgMarkup(label, size, { logoHref });
  } catch (cause) {
    const message =
      cause instanceof Error
        ? cause.message
        : "The QR code could not be generated for this label.";
    return (
      <div
        className="ioio-label-qr-error"
        role="alert"
        aria-label="Label QR error"
      >
        {message}
      </div>
    );
  }

  return (
    <div
      className={`ioio-label-svg-preview ioio-label-svg-preview-${label.layout}`}
      dangerouslySetInnerHTML={{
        __html: markup,
      }}
    />
  );
}

export async function downloadIoioLabelSvg(
  label: IoioLabelData,
  size?: IoioPrintDimensions
) {
  if (typeof window === "undefined") return;
  const qrError =
    label.qrValue !== undefined ? getIoioLabelQrError(label, size) : null;
  if (qrError) throw new Error(qrError);
  const logoDataUrl = label.qrValue ? await loadIoioQrLogoDataUrl() : undefined;
  const svg = renderIoioLabelSvgMarkup(label, size, {
    ...(logoDataUrl ? { logoHref: logoDataUrl } : {}),
  });
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `ioio-${label.code
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")}.svg`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 500);
}
