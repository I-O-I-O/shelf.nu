import QRCode from "qrcode-generator";

export const IOIO_QR_RED = "#ef0a2f";
export const IOIO_QR_QUIET_ZONE_MODULES = 4;
export const IOIO_QR_MIN_MODULE_MM = 0.27;

const LOGO_HREF = "/static/images/ioio-logo-white.png";
const LOGO_ASPECT_RATIO = 316 / 129;
const LOGO_WIDTH_RATIO = 0.29;

let logoDataUrlRequest: Promise<string> | undefined;

/** Resolves the canonical logo to a self-contained, decoded image for SVG/print. */
export function loadIoioQrLogoDataUrl() {
  if (typeof window === "undefined") {
    return Promise.reject(
      new Error("The IOIO logo can only be loaded in a browser.")
    );
  }
  if (logoDataUrlRequest) return logoDataUrlRequest;

  logoDataUrlRequest = (async () => {
    const response = await fetch(LOGO_HREF);
    if (!response.ok) throw new Error("The IOIO logo could not be loaded.");
    const blob = await response.blob();
    if (!blob.type.startsWith("image/")) {
      throw new Error("The IOIO logo asset is not a valid image.");
    }
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    const chunkSize = 0x8000;
    for (let index = 0; index < bytes.length; index += chunkSize) {
      binary += String.fromCharCode(
        ...bytes.subarray(index, index + chunkSize)
      );
    }
    const dataUrl = `data:${blob.type};base64,${window.btoa(binary)}`;
    const image = new Image();
    image.src = dataUrl;
    await image.decode();
    if (!image.naturalWidth || !image.naturalHeight) {
      throw new Error("The IOIO logo image is empty.");
    }

    // Tint the transparent logo before embedding it in SVG. SVG image masks
    // can be interpreted inconsistently by inline browser previews, making
    // their rectangular image bounds appear instead of the logo silhouette.
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("The IOIO logo could not be prepared.");
    context.drawImage(image, 0, 0);
    context.globalCompositeOperation = "source-in";
    context.fillStyle = IOIO_QR_RED;
    context.fillRect(0, 0, canvas.width, canvas.height);
    const redLogoDataUrl = canvas.toDataURL("image/png");
    const redLogo = new Image();
    redLogo.src = redLogoDataUrl;
    await redLogo.decode();
    if (!redLogo.naturalWidth || !redLogo.naturalHeight) {
      throw new Error("The IOIO logo could not be prepared.");
    }
    return redLogoDataUrl;
  })().catch((error: unknown) => {
    logoDataUrlRequest = undefined;
    throw error;
  });

  return logoDataUrlRequest;
}

export type IoioQrMatrix = {
  modules: boolean[][];
  moduleCount: number;
  version: number;
  modulePath: string;
};

export function createIoioQrMatrix(value: string): IoioQrMatrix {
  if (!value.trim()) {
    throw new Error("A QR value is required to generate this label.");
  }

  const qr = QRCode(0, "H");
  qr.addData(value);
  qr.make();

  const moduleCount = qr.getModuleCount();
  if (!moduleCount || (moduleCount - 17) % 4 !== 0) {
    throw new Error("The QR encoder returned an invalid matrix.");
  }

  const svg = qr.createSvgTag({ cellSize: 1, margin: 0, scalable: true });
  const modulePath = svg.match(/<path d="([^"]+)"/u)?.[1];
  if (!modulePath) throw new Error("The QR encoder returned no module path.");

  return {
    moduleCount,
    version: (moduleCount - 17) / 4,
    modulePath,
    modules: Array.from({ length: moduleCount }, (_, row) =>
      Array.from({ length: moduleCount }, (_, column) => qr.isDark(row, column))
    ),
  };
}

function getCenterLogoBox(moduleCount: number) {
  const width = moduleCount * LOGO_WIDTH_RATIO + 4;
  const height = width / LOGO_ASPECT_RATIO + 1;
  return {
    x: (moduleCount - width) / 2,
    y: (moduleCount - height) / 2,
    width,
    height,
  };
}

// Standard QR alignment-pattern centers, matching qrcode-generator's encoder.
const ALIGNMENT_PATTERN_CENTERS: number[][] = [
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
  [6, 30, 54],
  [6, 32, 58],
  [6, 34, 62],
  [6, 26, 46, 66],
  [6, 26, 48, 70],
  [6, 26, 50, 74],
  [6, 30, 54, 78],
  [6, 30, 56, 82],
  [6, 30, 58, 86],
  [6, 34, 62, 90],
  [6, 28, 50, 72, 94],
  [6, 26, 50, 74, 98],
  [6, 30, 54, 78, 102],
  [6, 28, 54, 80, 106],
  [6, 32, 58, 84, 110],
  [6, 30, 58, 86, 114],
  [6, 34, 62, 90, 118],
  [6, 26, 50, 74, 98, 122],
  [6, 30, 54, 78, 102, 126],
  [6, 26, 52, 78, 104, 130],
  [6, 30, 56, 82, 108, 134],
  [6, 34, 60, 86, 112, 138],
  [6, 30, 58, 86, 114, 142],
  [6, 34, 62, 90, 118, 146],
  [6, 30, 54, 78, 102, 126, 150],
  [6, 24, 50, 76, 102, 128, 154],
  [6, 28, 54, 80, 106, 132, 158],
  [6, 32, 58, 84, 110, 136, 162],
  [6, 26, 54, 82, 110, 138, 166],
  [6, 30, 58, 86, 114, 142, 170],
];

function getProtectedQrModules(matrix: IoioQrMatrix) {
  const { moduleCount, version } = matrix;
  const protectedModules = new Set<number>();
  const add = (row: number, column: number) => {
    if (row >= 0 && column >= 0 && row < moduleCount && column < moduleCount) {
      protectedModules.add(row * moduleCount + column);
    }
  };

  // Finder patterns and their one-module separators.
  for (const [top, left] of [
    [0, 0],
    [moduleCount - 7, 0],
    [0, moduleCount - 7],
  ]) {
    for (let row = top - 1; row <= top + 7; row += 1) {
      for (let column = left - 1; column <= left + 7; column += 1) {
        add(row, column);
      }
    }
  }

  // Timing patterns.
  for (let index = 8; index < moduleCount - 8; index += 1) {
    add(6, index);
    add(index, 6);
  }

  // Alignment patterns, excluding the three positions occupied by finders.
  const centers = ALIGNMENT_PATTERN_CENTERS[version - 1] ?? [];
  for (const rowCenter of centers) {
    for (const columnCenter of centers) {
      if (
        (rowCenter === 6 && columnCenter === 6) ||
        (rowCenter === 6 && columnCenter === moduleCount - 7) ||
        (rowCenter === moduleCount - 7 && columnCenter === 6)
      ) {
        continue;
      }
      for (let row = rowCenter - 2; row <= rowCenter + 2; row += 1) {
        for (
          let column = columnCenter - 2;
          column <= columnCenter + 2;
          column += 1
        ) {
          add(row, column);
        }
      }
    }
  }

  // Format information and its fixed dark module.
  for (let index = 0; index < 15; index += 1) {
    if (index < 6) add(index, 8);
    else if (index < 8) add(index + 1, 8);
    else add(moduleCount - 15 + index, 8);

    if (index < 8) add(8, moduleCount - index - 1);
    else if (index < 9) add(8, 15 - index);
    else add(8, 14 - index);
  }
  add(moduleCount - 8, 8);

  // Version information is present in versions 7 and above.
  if (version >= 7) {
    for (let index = 0; index < 18; index += 1) {
      add(Math.floor(index / 3), (index % 3) + moduleCount - 11);
      add((index % 3) + moduleCount - 11, Math.floor(index / 3));
    }
  }

  return [...protectedModules].map((cell) => ({
    row: Math.floor(cell / moduleCount),
    column: cell % moduleCount,
  }));
}

function stableSvgId(value: string) {
  let hash = 2166136261;
  for (const character of value) {
    hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  }
  return `ioio-qr-${(hash >>> 0).toString(36)}`;
}

function svgNumber(value: number) {
  return Number(value.toFixed(4)).toString();
}

export function getIoioQrModulePitchMm(
  qrBlockSizeMm: number,
  moduleCount: number
) {
  return qrBlockSizeMm / (moduleCount + IOIO_QR_QUIET_ZONE_MODULES * 2);
}

export function renderIoioBrandedQrContents(
  matrix: IoioQrMatrix,
  value: string,
  x: number,
  y: number,
  qrBlockSizeMm: number,
  logoHref?: string
) {
  const quiet = IOIO_QR_QUIET_ZONE_MODULES;
  const totalUnits = matrix.moduleCount + quiet * 2;
  const unitMm = qrBlockSizeMm / totalUnits;
  const symbolX = x + quiet * unitMm;
  const symbolY = y + quiet * unitMm;
  const logoBox = getCenterLogoBox(matrix.moduleCount);
  const logoId = stableSvgId(value);
  const finders = [
    [0, 0],
    [0, matrix.moduleCount - 7],
    [matrix.moduleCount - 7, 0],
  ]
    .map(([row, column]) => {
      const x0 = symbolX + column * unitMm;
      const y0 = symbolY + row * unitMm;
      return `<g data-qr-finder="true">
        <rect x="${svgNumber(x0 + unitMm)}" y="${svgNumber(
          y0 + unitMm
        )}" width="${svgNumber(5 * unitMm)}" height="${svgNumber(
          5 * unitMm
        )}" fill="#ffffff"/>
        <rect x="${svgNumber(x0 + 2 * unitMm)}" y="${svgNumber(
          y0 + 2 * unitMm
        )}" width="${svgNumber(3 * unitMm)}" height="${svgNumber(
          3 * unitMm
        )}" rx="${svgNumber(0.2 * unitMm)}" fill="${IOIO_QR_RED}"/>
      </g>`;
    })
    .join("");

  let logoMarkup = "";
  if (logoBox) {
    const logoWidth = matrix.moduleCount * LOGO_WIDTH_RATIO;
    const logoHeight = logoWidth / LOGO_ASPECT_RATIO;
    const logoX = symbolX + ((matrix.moduleCount - logoWidth) * unitMm) / 2;
    const logoY = symbolY + ((matrix.moduleCount - logoHeight) * unitMm) / 2;
    const cutoutX = symbolX + logoBox.x * unitMm;
    const cutoutY = symbolY + logoBox.y * unitMm;
    const cutoutWidth = logoBox.width * unitMm;
    const cutoutHeight = logoBox.height * unitMm;

    logoMarkup = `<rect data-qr-logo-protection="true" data-qr-logo-x="${svgNumber(
      logoBox.x
    )}" data-qr-logo-y="${svgNumber(
      logoBox.y
    )}" data-qr-logo-width="${svgNumber(
      logoBox.width
    )}" data-qr-logo-height="${svgNumber(logoBox.height)}" x="${svgNumber(
      cutoutX
    )}" y="${svgNumber(cutoutY)}" width="${svgNumber(
      cutoutWidth
    )}" height="${svgNumber(cutoutHeight)}" fill="#ffffff"/>${
      logoHref
        ? `<image data-qr-logo-image="true" href="${logoHref}" x="${svgNumber(
            logoX
          )}" y="${svgNumber(logoY)}" width="${svgNumber(
            logoWidth * unitMm
          )}" height="${svgNumber(
            logoHeight * unitMm
          )}" preserveAspectRatio="none"/>`
        : ""
    }`;
  }

  const protectedModules = logoBox
    ? getProtectedQrModules(matrix)
        .filter(
          ({ row, column }) =>
            !(
              column < logoBox.x + logoBox.width &&
              column + 1 > logoBox.x &&
              row < logoBox.y + logoBox.height &&
              row + 1 > logoBox.y
            )
        )
        .map(({ row, column }) => {
          const moduleX = symbolX + column * unitMm;
          const moduleY = symbolY + row * unitMm;
          return `<rect data-qr-function-module="true" data-qr-row="${row}" data-qr-column="${column}" x="${svgNumber(
            moduleX
          )}" y="${svgNumber(moduleY)}" width="${svgNumber(
            unitMm
          )}" height="${svgNumber(unitMm)}" fill="${
            matrix.modules[row]?.[column] ? "#050505" : "#ffffff"
          }" shape-rendering="crispEdges"/>`;
        })
        .join("")
    : "";

  return `<g data-ioio-qr="true" data-qr-version="${
    matrix.version
  }" data-qr-matrix="${logoId}" data-qr-x="${svgNumber(
    x
  )}" data-qr-y="${svgNumber(y)}" data-qr-block-size="${svgNumber(
    qrBlockSizeMm
  )}">
    <rect x="${svgNumber(x)}" y="${svgNumber(y)}" width="${svgNumber(
      qrBlockSizeMm
    )}" height="${svgNumber(qrBlockSizeMm)}" fill="#ffffff"/>
    <path data-qr-encoder-modules="true" d="${
      matrix.modulePath
    }" fill="#050505" transform="translate(${svgNumber(symbolX)} ${svgNumber(
      symbolY
    )}) scale(${svgNumber(
      unitMm
    )})" shape-rendering="crispEdges" stroke="#ffffff" stroke-width="0.06" stroke-linejoin="round"/>
    ${logoMarkup}
    ${protectedModules}
    ${finders}
  </g>`;
}

export function renderIoioBrandedQrSvgMarkup(
  value: string,
  sizeMm: number,
  logoHref?: string
) {
  const matrix = createIoioQrMatrix(value);
  const size = svgNumber(sizeMm);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}mm" height="${size}mm" viewBox="0 0 ${size} ${size}">${renderIoioBrandedQrContents(
    matrix,
    value,
    0,
    0,
    sizeMm,
    logoHref
  )}</svg>`;
}
