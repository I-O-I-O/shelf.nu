import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function pdfjsResourceUrl(...segments: string[]) {
  const require = createRequire(import.meta.url);
  const entryPath = require.resolve("pdfjs-dist/legacy/build/pdf.mjs");
  const packageRoot = path.resolve(path.dirname(entryPath), "../../..");
  const resourcePath = path.join(packageRoot, ...segments);
  return pathToFileURL(`${resourcePath}${path.sep}`).href;
}
