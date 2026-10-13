import { groupStudentAssets } from "~/components/ioio-student/inventory-presentation";
import type { StudentAsset } from "~/modules/ioio-student/service.server";

export type ReportAssetOption = {
  id: string;
  label: string;
  units: Array<{ id: string; label: string; reported: boolean }>;
  defaultUnitId: string | null;
};

/** Keep the report selector on the same logical products as Student inventory. */
export function getReportAssetOptions(
  inventoryAssets: StudentAsset[],
  formatLabel: (value: string) => string,
  reportedUnitIds: ReadonlySet<string> = new Set()
): ReportAssetOption[] {
  const assetById = new Map(inventoryAssets.map((asset) => [asset.id, asset]));
  return groupStudentAssets(inventoryAssets)
    .map((product) => {
      const units =
        product.type === "INDIVIDUAL"
          ? product.sourceAssetIds
              .map((id) => assetById.get(id))
              .filter((asset) => asset !== undefined)
              .map((asset) => ({
                id: asset.id,
                baseLabel:
                  asset.title.match(/(?:^|\s)(#\d+)\s*$/u)?.[1] ??
                  (asset.sequentialId ? `#${asset.sequentialId}` : null) ??
                  "Unit number missing",
                reported: reportedUnitIds.has(asset.id),
              }))
              .sort((left, right) =>
                left.baseLabel.localeCompare(right.baseLabel)
              )
              .map(({ baseLabel, ...unit }) => ({
                ...unit,
                label: unit.reported ? `${baseLabel} — Reported` : baseLabel,
              }))
          : [];
      return {
        id: product.id,
        label: formatLabel(product.title),
        units,
        defaultUnitId: units.length === 1 ? units[0].id : null,
      };
    })
    .sort((left, right) => left.label.localeCompare(right.label));
}

/** Search logical products and their unit identifiers, but render only a short result list. */
export function searchReportAssets(
  assets: ReportAssetOption[],
  query: string,
  limit = 8
) {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return assets.slice(0, limit);
  return assets
    .filter((asset) =>
      [asset.label, ...asset.units.map((unit) => unit.label)]
        .join(" ")
        .toLocaleLowerCase()
        .includes(normalizedQuery)
    )
    .slice(0, limit);
}
