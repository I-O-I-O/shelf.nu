import type { ReactNode } from "react";
import { useEffect, useRef } from "react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "~/components/shared/sheet";

export function NotificationPanel({
  mobile,
  open,
  onOpenChange,
  label,
  title,
  description,
  trigger,
  triggerClassName,
  headerIcon,
  children,
}: {
  mobile: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  label: string;
  title: string;
  description: string;
  trigger: ReactNode;
  triggerClassName: string;
  headerIcon?: ReactNode;
  children: ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    if (mobile) {
      // The shell hides the mobile trigger at md. Release the modal's scroll
      // lock if the viewport crosses that breakpoint while the sheet is open.
      const desktop = window.matchMedia("(min-width: 768px)");
      const closeOnDesktop = (event: MediaQueryListEvent) => {
        if (event.matches) onOpenChange(false);
      };
      desktop.addEventListener("change", closeOnDesktop);
      return () => desktop.removeEventListener("change", closeOnDesktop);
    }

    function handlePointerDown(event: PointerEvent) {
      if (
        event.target instanceof Node &&
        !containerRef.current?.contains(event.target)
      ) {
        onOpenChange(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onOpenChange(false);
        triggerRef.current?.focus();
      }
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [mobile, open, onOpenChange]);

  const button = (
    <button
      ref={triggerRef}
      type="button"
      aria-label={label}
      aria-expanded={open}
      className={triggerClassName}
      onClick={mobile ? undefined : () => onOpenChange(!open)}
    >
      {trigger}
    </button>
  );

  return (
    <div ref={containerRef} className="relative">
      {mobile ? (
        <Sheet open={open} onOpenChange={onOpenChange}>
          <SheetTrigger asChild>{button}</SheetTrigger>
          <SheetContent
            side="bottom"
            overlayClassName="z-[60] bg-black/55"
            closeButtonClassName="right-4 top-3 flex size-11 items-center justify-center rounded-lg text-gray-700 opacity-100 hover:bg-gray-100"
            className="z-[60] flex max-h-[min(85dvh,calc(100dvh-env(safe-area-inset-top)-1rem))] w-full flex-col gap-0 overflow-hidden rounded-t-2xl border-gray-200 bg-white p-0 pb-[env(safe-area-inset-bottom)] text-gray-900"
          >
            <SheetHeader className="shrink-0 border-b border-gray-100 py-4 pl-4 pr-16 text-left">
              <SheetTitle className="flex items-center gap-2 text-base text-gray-950">
                {title}
                {headerIcon}
              </SheetTitle>
              <SheetDescription className="text-xs text-gray-600">
                {description}
              </SheetDescription>
            </SheetHeader>
            <div className="min-h-0 min-w-0 touch-pan-y overflow-y-auto overscroll-contain px-4 pb-4 [overflow-wrap:anywhere]">
              {children}
            </div>
          </SheetContent>
        </Sheet>
      ) : (
        <>
          {button}
          {open ? (
            <div className="absolute right-0 top-12 z-50 max-h-[calc(100dvh-5rem)] w-[min(22rem,calc(100vw-2rem))] overflow-y-auto overscroll-contain rounded-2xl border border-gray-200 bg-white p-4 shadow-xl [overflow-wrap:anywhere]">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-black text-gray-950">{title}</p>
                  <p className="mt-0.5 text-xs text-gray-500">{description}</p>
                </div>
                {headerIcon}
              </div>
              {children}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
