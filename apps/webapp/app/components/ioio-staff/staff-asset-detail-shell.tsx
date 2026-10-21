import type { ReactNode } from "react";
import HorizontalTabs from "~/components/layout/horizontal-tabs";

/** The IOIO staff detail keeps Shelf's Book control and Overview route. */
export function StaffAssetDetailShell({
  bookAction,
  children,
}: {
  bookAction: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="relative">
      <div className="flex justify-end px-4 py-1">{bookAction}</div>
      <HorizontalTabs items={[{ to: "overview", content: "Overview" }]} />
      <div>{children}</div>
    </div>
  );
}
