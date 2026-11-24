import type { ReactNode } from "react";
import { CircleHelp } from "lucide-react";
import { InfoTooltip } from "./info-tooltip";

export function SettingHelpLabel({
  label,
  help,
}: {
  label: string;
  help: ReactNode;
}) {
  return (
    <span className="inline-flex items-center gap-1">
      <span>{label}</span>
      <InfoTooltip
        icon={<CircleHelp className="size-4" aria-hidden="true" />}
        content={help}
      />
    </span>
  );
}
