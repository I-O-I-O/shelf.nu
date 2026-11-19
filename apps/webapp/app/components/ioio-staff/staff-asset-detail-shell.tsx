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
    <div className="relative min-w-0">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-2 max-md:mb-2 max-md:border-b max-md:border-gray-200 max-md:pb-1 md:flex-col md:items-stretch">
        <HorizontalTabs
          items={[{ to: "overview", content: "Overview" }]}
          className="max-md:mx-0 max-md:mb-0 max-md:overflow-visible max-md:border-b-0 max-md:pl-0"
        />
        <div className="ml-auto flex min-w-0 justify-end md:-order-1 md:px-4 md:py-1">
          {bookAction}
        </div>
      </div>
      <div>{children}</div>
    </div>
  );
}
