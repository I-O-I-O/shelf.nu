/** Real lookup probe. No database writes, storage uploads, or mocked providers. */
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import type { ImportProductEnrichmentRow } from "../app/modules/ioio-staff/product-enrichment.server";

config({
  path: fileURLToPath(new URL("../../../.env", import.meta.url)),
  quiet: true,
});
const options = new Map(
  process.argv.slice(2).map((argument) => {
    const [key, ...value] = argument.split("=");
    return [key, value.join("=")];
  })
);
if (!process.env.BRAVE_SEARCH_API_KEY?.trim()) {
  process.stdout.write(
    JSON.stringify(
      {
        status: "BLOCKED",
        failureReason: "SEARCH_PROVIDER_NOT_CONFIGURED",
        provider: "BRAVE_WEB_SEARCH",
        requiredEnvironmentVariable: "BRAVE_SEARCH_API_KEY",
        configurationFile: "repository root .env",
      },
      null,
      2
    ) + "\n"
  );
  process.exitCode = 2;
} else {
  try {
    const { enrichImportProductRows } = await import(
      "../app/modules/ioio-staff/product-enrichment.server"
    );
    const { rows, diagnostics } =
      await enrichImportProductRows<ImportProductEnrichmentRow>(
        [
          {
            rowNumber: 1,
            manufacturer: options.get("--manufacturer") || "Seeed Studio",
            title: options.get("--product") || "XIAO ESP32-S3 Sense",
            manufacturerPartNumber: options.get("--mpn") || "113991115",
            sourceDescription: null,
          },
        ],
        []
      );
    const image = rows[0].productImageProposal;
    process.stdout.write(
      JSON.stringify(
        {
          status: image?.status,
          failureReason: image?.failureReason,
          source: image?.source,
          sourceUrl: image?.sourceUrl,
          identityEvidence: image?.identityEvidence,
          attempt: image?.attempt,
          searchProviderConfigured: diagnostics.searchProviderConfigured,
          proposalImageStored: false,
          applyImageUploaded: false,
          applyImageAttached: false,
        },
        null,
        2
      ) + "\n"
    );
    if (image?.status !== "IMAGE_FOUND") process.exitCode = 2;
  } catch (cause) {
    // Never print arbitrary exception bodies that might carry provider secrets.
    process.stdout.write(
      JSON.stringify(
        {
          status: "BLOCKED",
          failureReason: "APP_ENVIRONMENT_OR_LOOKUP_FAILED",
          errorType: cause instanceof Error ? cause.name : "unknown",
          configurationFile: "repository root .env",
        },
        null,
        2
      ) + "\n"
    );
    process.exitCode = 2;
  }
}
