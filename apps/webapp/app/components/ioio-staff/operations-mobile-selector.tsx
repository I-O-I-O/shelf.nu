import { useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { Link } from "react-router";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "~/components/shared/sheet";

export type OperationsCategoryOption = {
  id: string;
  label: string;
  href: string;
};

export function OperationsMobileSelector({
  activeId,
  options,
}: {
  activeId: string;
  options: readonly OperationsCategoryOption[];
}) {
  const [open, setOpen] = useState(false);
  const active = options.find((option) => option.id === activeId) ?? options[0];

  if (!active) return null;

  return (
    <div className="md:hidden">
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>
          <button
            type="button"
            aria-label={`Choose operation category. Current category: ${active.label}`}
            aria-expanded={open}
            aria-controls="operations-mobile-categories"
            className="flex min-h-11 w-full items-center justify-between gap-3 rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm font-semibold text-gray-800 shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-red-700"
          >
            <span className="min-w-0 truncate">{active.label}</span>
            <ChevronDown
              aria-hidden="true"
              className={`size-4 shrink-0 transition-transform ${
                open ? "rotate-180" : ""
              }`}
            />
          </button>
        </SheetTrigger>
        <SheetContent
          id="operations-mobile-categories"
          side="bottom"
          overlayClassName="bg-black/55"
          closeButtonClassName="right-3 top-3 flex size-11 items-center justify-center rounded-lg text-gray-600 opacity-100 transition-colors hover:bg-gray-100 focus:ring-red-700 dark:text-gray-200 dark:hover:bg-gray-800"
          className="max-h-[80dvh] w-full touch-pan-y overflow-y-auto overscroll-contain rounded-t-2xl border-red-100 bg-white px-4 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-5 text-gray-900 dark:border-gray-800 dark:bg-gray-950 dark:text-gray-50"
        >
          <SheetHeader className="mb-4 pr-10 text-left">
            <SheetTitle className="text-gray-950 dark:text-gray-50">
              Choose a category
            </SheetTitle>
            <SheetDescription>
              Show one type of lab work at a time.
            </SheetDescription>
          </SheetHeader>
          <nav aria-label="Operation categories" className="space-y-1">
            {options.map((option) => (
              <SheetClose key={option.id} asChild>
                <Link
                  to={option.href}
                  aria-current={option.id === activeId ? "page" : undefined}
                  onClick={() => setOpen(false)}
                  className={`flex min-h-11 items-center justify-between gap-3 rounded-lg px-3 py-2 text-sm font-semibold focus:outline-none focus-visible:ring-2 focus-visible:ring-red-700 ${
                    option.id === activeId
                      ? "bg-red-50 text-red-800 dark:bg-red-950/50 dark:text-red-200"
                      : "text-gray-700 hover:bg-red-50 hover:text-red-800 dark:text-gray-200 dark:hover:bg-gray-800 dark:hover:text-white"
                  }`}
                >
                  <span>{option.label}</span>
                  {option.id === activeId ? (
                    <Check
                      aria-hidden="true"
                      className="size-4 shrink-0 text-red-700"
                    />
                  ) : null}
                </Link>
              </SheetClose>
            ))}
          </nav>
        </SheetContent>
      </Sheet>
    </div>
  );
}
