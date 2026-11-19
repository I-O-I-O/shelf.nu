import type { ReactNode } from "react";
import { useState } from "react";
import { SlidersHorizontal } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "~/components/shared/sheet";

export function MobileAssetFilters({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="w-full md:hidden">
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>
          <button
            type="button"
            aria-label="Open asset filters"
            aria-expanded={open}
            aria-controls="mobile-asset-filters"
            className="flex min-h-11 w-full items-center justify-between gap-2 rounded-lg border border-gray-300 bg-white px-3 text-sm font-semibold text-gray-800 shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-red-700"
          >
            <span>Filters</span>
            <SlidersHorizontal aria-hidden="true" className="size-4" />
          </button>
        </SheetTrigger>
        <SheetContent
          id="mobile-asset-filters"
          side="bottom"
          overlayClassName="bg-black/55"
          closeButtonClassName="right-3 top-3 flex size-11 items-center justify-center rounded-lg text-gray-600 opacity-100 transition-colors hover:bg-gray-100 focus:ring-red-700 dark:text-gray-200 dark:hover:bg-gray-800"
          className="max-h-[80dvh] w-full touch-pan-y overflow-y-auto overscroll-contain rounded-t-2xl border-gray-200 bg-white px-4 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-5 text-gray-900 dark:border-gray-800 dark:bg-gray-950 dark:text-gray-50"
        >
          <SheetHeader className="mb-4 pr-10 text-left">
            <SheetTitle className="text-gray-950 dark:text-gray-50">
              Asset filters
            </SheetTitle>
            <SheetDescription>
              Choose one or more filters to narrow the asset list.
            </SheetDescription>
          </SheetHeader>
          <div className="space-y-2">{children}</div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
