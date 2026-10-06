import { readBarcodes } from "zxing-wasm/reader";
import { prepareZXingModule } from "zxing-wasm/reader";
import QRCode from "qrcode-generator";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  createIoioQrMatrix,
  renderIoioBrandedQrSvgMarkup,
} from "./ioio-branded-qr";
import {
  getIoioLabelQrError,
  renderIoioLabelSvgMarkup,
  type IoioLabelData,
} from "./ioio-labels";
import { IOIO_ITEM_PRINT_PRESETS } from "./ioio-label-sizing";

const sourceLogoBytes = await readFile(
  resolve(process.cwd(), "public/static/images/ioio-logo-white.png")
);
const { data: sourceLogoPixels, info: sourceLogoInfo } = await sharp(
  sourceLogoBytes
)
  .ensureAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true });
for (let index = 0; index < sourceLogoPixels.length; index += 4) {
  sourceLogoPixels[index] = 239;
  sourceLogoPixels[index + 1] = 10;
  sourceLogoPixels[index + 2] = 47;
}
const logoBytes = await sharp(sourceLogoPixels, {
  raw: {
    width: sourceLogoInfo.width,
    height: sourceLogoInfo.height,
    channels: 4,
  },
})
  .png()
  .toBuffer();
const logoDataUrl = `data:image/png;base64,${logoBytes.toString("base64")}`;
const require = createRequire(resolve(process.cwd(), "vitest.config.ts"));
const zxingWasm = await readFile(
  require.resolve("zxing-wasm/reader/zxing_reader.wasm")
);
await prepareZXingModule({
  overrides: { wasmBinary: Uint8Array.from(zxingWasm).buffer },
  fireImmediately: true,
});

async function decodeSvg(svg: string) {
  const rendered = sharp(Buffer.from(svg), { density: 600 });
  const png = await rendered.png().toBuffer();
  const pngMetadata = await sharp(png).metadata();
  const qr = svg.match(
    /data-qr-x="([\d.]+)" data-qr-y="([\d.]+)" data-qr-block-size="([\d.]+)"/u
  );
  if (!qr || !pngMetadata.width)
    throw new Error("The rendered label has no QR block.");
  const pxPerMm =
    pngMetadata.width / Number(svg.match(/width="([\d.]+)mm"/u)?.[1]);
  const qrBlockSizeMm = Number(qr[3]);
  const cropped = await sharp(png)
    .extract({
      left: Math.round(Number(qr[1]) * pxPerMm),
      top: Math.round(Number(qr[2]) * pxPerMm),
      width: Math.round(qrBlockSizeMm * pxPerMm),
      height: Math.round(qrBlockSizeMm * pxPerMm),
    })
    .png()
    .toBuffer();
  const results = await readBarcodes(cropped, {
    formats: ["QRCode"],
    tryHarder: false,
    tryRotate: false,
    tryInvert: false,
    tryDownscale: false,
    isPure: true,
    maxNumberOfSymbols: 1,
    returnErrors: true,
  });
  if (!results[0]?.text) {
    throw new Error(
      JSON.stringify(
        results.map(({ text, error, isValid }) => ({ text, error, isValid }))
      )
    );
  }
  return results[0]?.text;
}

function expectNoFunctionModulesInLogoClearspace(svg: string) {
  const protection = svg.match(
    /data-qr-logo-protection="true" data-qr-logo-x="([\d.]+)" data-qr-logo-y="([\d.]+)" data-qr-logo-width="([\d.]+)" data-qr-logo-height="([\d.]+)"/u
  );
  expect(protection).not.toBeNull();
  if (!protection) return;

  const [, xText, yText, widthText, heightText] = protection;
  const x = Number(xText);
  const y = Number(yText);
  const width = Number(widthText);
  const height = Number(heightText);
  const functionModules = [
    ...svg.matchAll(
      /data-qr-function-module="true" data-qr-row="(\d+)" data-qr-column="(\d+)"/gu
    ),
  ];

  for (const [, rowText, columnText] of functionModules) {
    const row = Number(rowText);
    const column = Number(columnText);
    const intersects =
      column < x + width && column + 1 > x && row < y + height && row + 1 > y;
    expect(
      intersects,
      `function module (${row}, ${column}) overlaps logo`
    ).toBe(false);
  }
}

async function expectNoDarkPixelsOverLogo(svg: string, qrSizeMm: number) {
  const image = svg.match(
    /<image data-qr-logo-image="true" href="[^"]+" x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/u
  );
  expect(image).not.toBeNull();
  if (!image) return;

  const png = await sharp(Buffer.from(svg), { density: 600 }).png().toBuffer();
  const metadata = await sharp(png).metadata();
  if (!metadata.width) throw new Error("Could not rasterize the QR logo.");
  const pxPerMm = metadata.width / qrSizeMm;
  const logoPixels = await sharp(png)
    .extract({
      left: Math.floor(Number(image[1]) * pxPerMm),
      top: Math.floor(Number(image[2]) * pxPerMm),
      width: Math.ceil(Number(image[3]) * pxPerMm),
      height: Math.ceil(Number(image[4]) * pxPerMm),
    })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let darkPixelCount = 0;
  for (let index = 0; index < logoPixels.data.length; index += 3) {
    if (
      (logoPixels.data[index] ?? 255) < 80 &&
      (logoPixels.data[index + 1] ?? 255) < 80 &&
      (logoPixels.data[index + 2] ?? 255) < 80
    ) {
      darkPixelCount += 1;
    }
  }
  expect(darkPixelCount).toBe(0);
}

function rawMatrixSvg(value: string) {
  const matrix = createIoioQrMatrix(value);
  const size = matrix.moduleCount + 8;
  const qrSizeMm = 32;
  const blockSizeMm = qrSizeMm + 1.35;
  const moduleMm = qrSizeMm / size;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${blockSizeMm}mm" height="${blockSizeMm}mm" viewBox="0 0 ${blockSizeMm} ${blockSizeMm}"><rect width="${blockSizeMm}" height="${blockSizeMm}" fill="white"/><path d="${
    matrix.modulePath
  }" transform="translate(${4 * moduleMm} ${
    4 * moduleMm
  }) scale(${moduleMm})" fill="black"/><g data-ioio-qr="true" data-qr-x="0" data-qr-y="0" data-qr-block-size="${blockSizeMm}"/></svg>`;
}

function itemLabel(qrValue: string): IoioLabelData {
  return {
    layout: "horizontal",
    variant: "item",
    color: "#b91c1c",
    colorName: "Red",
    code: "ITEM",
    title: "Makey Makey Kit",
    subtitle: "",
    unitNumber: "#001",
    room: "IOIO Lab",
    scanText: "",
    qrValue,
  };
}

describe("functional IOIO branded QR labels", () => {
  it("confirms the installed QR encoder baseline is decodable", async () => {
    const payload = "https://ioio.example.test/qr/qr_asset_a_123";
    const qr = QRCode(0, "H");
    qr.addData(payload);
    qr.make();
    const png = Buffer.from(qr.createDataURL(12, 4).split(",")[1]!, "base64");
    const results = await readBarcodes(png, {
      formats: ["QRCode"],
      tryHarder: true,
      isPure: true,
      maxNumberOfSymbols: 1,
    });
    expect(results[0]?.text).toBe(payload);

    const nativeSvg = qr.createSvgTag({
      cellSize: 12,
      margin: 4,
      scalable: false,
    });
    const nativePng = await sharp(Buffer.from(nativeSvg)).png().toBuffer();
    const nativeResults = await readBarcodes(nativePng, {
      formats: ["QRCode"],
      tryHarder: true,
      maxNumberOfSymbols: 1,
    });
    expect(nativeResults[0]?.text).toBe(payload);
  });

  it("decodes the encoder matrix before IOIO styling", async () => {
    const payload = "https://ioio.example.test/qr/qr_asset_a_123";
    expect(await decodeSvg(rawMatrixSvg(payload))).toBe(payload);
  });

  it("decodes two different Shelf-style payloads from the branded QR renderer", async () => {
    const payloadA = "https://ioio.example.test/qr/qr_asset_a_123";
    const payloadB = "https://ioio.example.test/qr/qr_asset_b_456";
    const matrixA = createIoioQrMatrix(payloadA);
    const matrixB = createIoioQrMatrix(payloadB);

    expect(matrixA.modules).not.toEqual(matrixB.modules);
    for (const payload of [payloadA, payloadB]) {
      const svg = renderIoioBrandedQrSvgMarkup(payload, 36, logoDataUrl);
      expect(svg).toContain('data-qr-logo-protection="true"');
      expect(svg).toContain('data-qr-logo-image="true"');
      expect(svg).not.toContain("<mask");
      expect(svg).toContain(`href="${logoDataUrl}"`);
      expect(svg).not.toContain("INSTITUTE OF INTERACTIVE OBJECTS");
      expect(svg).not.toContain("data-qr-caption=");
      expectNoFunctionModulesInLogoClearspace(svg);
      expect(await decodeSvg(svg)).toBe(payload);
    }
  }, 20000);

  it("renders the IOIO logo silhouette without painting the image bounds red", async () => {
    const payload = "https://ioio.example.test/qr/logo-silhouette-check";
    const svg = renderIoioBrandedQrSvgMarkup(payload, 48, logoDataUrl);
    const image = svg.match(
      /<image data-qr-logo-image="true" href="[^"]+" x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/u
    );
    expect(image).not.toBeNull();
    expect(svg).not.toContain("<mask");

    const png = await sharp(Buffer.from(svg), { density: 600 })
      .png()
      .toBuffer();
    const metadata = await sharp(png).metadata();
    if (!metadata.width) throw new Error("Could not rasterize the QR logo.");
    const pxPerMm = metadata.width / 48;
    const logoPixels = await sharp(png)
      .extract({
        left: Math.floor(Number(image?.[1]) * pxPerMm),
        top: Math.floor(Number(image?.[2]) * pxPerMm),
        width: Math.ceil(Number(image?.[3]) * pxPerMm),
        height: Math.ceil(Number(image?.[4]) * pxPerMm),
      })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    let redPixelCount = 0;
    for (let index = 0; index < logoPixels.data.length; index += 3) {
      const red = logoPixels.data[index] ?? 0;
      const green = logoPixels.data[index + 1] ?? 255;
      const blue = logoPixels.data[index + 2] ?? 255;
      if (red > 180 && green < 80 && blue < 90) redPixelCount += 1;
    }
    const redCoverage =
      redPixelCount / (logoPixels.info.width * logoPixels.info.height);
    expect(redCoverage).toBeGreaterThan(0.1);
    expect(redCoverage).toBeLessThan(0.8);
  });

  it("renders Section and Shelf labels without a QR or reserved QR block", () => {
    const payload = "https://ioio.example.test/qr/location-target";
    for (const variant of ["section", "shelf"] as const) {
      const label = {
        ...itemLabel(payload),
        layout: "section" as const,
        variant,
        qrValue: undefined,
      };
      expect(getIoioLabelQrError(label, IOIO_ITEM_PRINT_PRESETS.s)).toBeNull();
      const svg = renderIoioLabelSvgMarkup(label, IOIO_ITEM_PRINT_PRESETS.s, {
        logoHref: logoDataUrl,
      });
      expect(svg).toContain(variant.toUpperCase());
      expect(svg).not.toContain('data-ioio-qr="true"');
      expect(svg).not.toContain("data-qr-block-size");
    }
  });

  it("rejects a QR payload if one is incorrectly attached to a Section or Shelf", () => {
    const payload = "https://ioio.example.test/qr/location-target";
    for (const variant of ["section", "shelf"] as const) {
      const label = {
        ...itemLabel(payload),
        layout: "section" as const,
        variant,
      };
      expect(getIoioLabelQrError(label, IOIO_ITEM_PRINT_PRESETS.s)).toMatch(
        /QR codes are not available for Sections or Shelves/u
      );
      expect(
        renderIoioLabelSvgMarkup(label, IOIO_ITEM_PRINT_PRESETS.s, {
          logoHref: logoDataUrl,
        })
      ).not.toContain('data-ioio-qr="true"');
    }
  });

  it("shows the canonical logo and decodes across QR versions including alignment-heavy versions", async () => {
    const targetVersions = new Set([2, 6, 7, 10]);
    const payloadsByVersion = new Map<number, string>();
    for (let length = 1; length <= 450; length += 1) {
      const payload =
        length <= 20
          ? "U".repeat(length)
          : `https://ioio.example.test/qr/${"u".repeat(length)}`;
      const { version } = createIoioQrMatrix(payload);
      if (targetVersions.has(version) && !payloadsByVersion.has(version)) {
        payloadsByVersion.set(version, payload);
      }
      if (payloadsByVersion.size === targetVersions.size) break;
    }

    expect([...payloadsByVersion.keys()].sort((a, b) => a - b)).toEqual(
      [...targetVersions].sort((a, b) => a - b)
    );

    for (const [version, payload] of payloadsByVersion) {
      const matrix = createIoioQrMatrix(payload);
      const svg = renderIoioBrandedQrSvgMarkup(payload, 48, logoDataUrl);
      expect(matrix.version).toBe(version);
      expect(svg).toContain('data-qr-logo-protection="true"');
      expect(svg).toContain('data-qr-logo-image="true"');
      expect(svg).not.toContain("<mask");
      expect(svg).not.toContain("INSTITUTE OF INTERACTIVE OBJECTS");
      expectNoFunctionModulesInLogoClearspace(svg);
      await expectNoDarkPixelsOverLogo(svg, 48);
      if (version >= 7) {
        expect(svg).toContain('data-qr-function-module="true"');
      }
      expect(svg).toContain(`href="${logoDataUrl}"`);
      expect(await decodeSvg(svg)).toBe(payload);
    }
  }, 60000);

  it("decodes two exact physical units of the same logical Kit from print-size labels", async () => {
    const payloadUnit001 = "http://127.0.0.1:3000/qr/unitQr001x";
    const payloadUnit002 = "http://127.0.0.1:3000/qr/unitQr002x";
    const size = IOIO_ITEM_PRINT_PRESETS.s;
    expect(createIoioQrMatrix(payloadUnit001).version).toBeGreaterThanOrEqual(
      4
    );

    const unit001Svg = renderIoioLabelSvgMarkup(
      itemLabel(payloadUnit001),
      size,
      { logoHref: logoDataUrl }
    );
    const unit002Svg = renderIoioLabelSvgMarkup(
      { ...itemLabel(payloadUnit002), unitNumber: "#002" },
      size,
      { logoHref: logoDataUrl }
    );

    expect(await decodeSvg(unit001Svg)).toBe(payloadUnit001);
    expect(await decodeSvg(unit002Svg)).toBe(payloadUnit002);
    expect(unit001Svg).not.toBe(unit002Svg);
    expect(unit001Svg).not.toContain("INSTITUTE OF INTERACTIVE OBJECTS");
    expect(unit001Svg).not.toContain("SCAN ME");
    expect(unit001Svg).toContain("data-qr-version=");
    expect(unit001Svg).toContain(`href="${logoDataUrl}"`);
  }, 20000);

  it("refuses QR output that is missing, too dense for the smallest item label, or too long to encode", () => {
    const payload = "https://ioio.example.test/qr/physical_unit_001";
    const label = itemLabel(payload);

    expect(getIoioLabelQrError(label, IOIO_ITEM_PRINT_PRESETS.xxs)).toMatch(
      /cannot fit a scannable QR code/u
    );
    expect(getIoioLabelQrError(label, IOIO_ITEM_PRINT_PRESETS.s)).toBeNull();
    expect(
      getIoioLabelQrError(
        { ...label, qrValue: undefined },
        IOIO_ITEM_PRINT_PRESETS.s
      )
    ).toMatch(/payload is missing/u);
    expect(
      getIoioLabelQrError(
        { ...label, qrValue: `https://ioio.example.test/${"x".repeat(5000)}` },
        IOIO_ITEM_PRINT_PRESETS.s
      )
    ).toMatch(/could not be generated/u);
  });
});
