import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import type { LucideIcon } from "lucide-react";
import { ChevronRight, MoreHorizontal, X } from "lucide-react";
import { Link, NavLink, useLocation } from "react-router";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "~/components/shared/sheet";

export type MobileNavigationItem = {
  to: string;
  label: string;
  Icon: LucideIcon;
  end?: boolean;
  group?: string;
};

export function MobileIoioHeader({
  homeHref,
  notifications,
  basket,
}: {
  homeHref: string;
  notifications: ReactNode;
  basket: ReactNode;
}) {
  return (
    <header
      data-testid="ioio-mobile-header"
      className="sticky top-0 z-30 bg-white/95 pt-[env(safe-area-inset-top)] backdrop-blur dark:bg-gray-950/95 md:hidden"
    >
      <div className="flex min-h-14 items-center justify-between gap-3 px-4 py-2">
        <Link
          to={homeHref}
          aria-label="IOIO Lab home"
          className="flex h-10 min-w-0 items-center justify-center rounded-lg bg-red-800 px-2 focus:outline-none focus:ring-2 focus:ring-red-700 focus:ring-offset-2"
        >
          <img
            src="/static/images/ioio-logo-white.png"
            alt=""
            className="h-8 w-auto max-w-28 object-contain"
          />
        </Link>
        <div className="flex shrink-0 items-center gap-2">
          {notifications}
          {basket}
        </div>
      </div>
    </header>
  );
}

function isItemActive(pathname: string, item: MobileNavigationItem) {
  return item.end
    ? pathname === item.to
    : pathname === item.to || pathname.startsWith(`${item.to}/`);
}

function groupNavigation(items: readonly MobileNavigationItem[]) {
  const groups: { heading?: string; items: MobileNavigationItem[] }[] = [];
  for (const item of items) {
    const group = groups.at(-1);
    if (group && group.heading === item.group) {
      group.items.push(item);
    } else {
      groups.push({ heading: item.group, items: [item] });
    }
  }
  return groups;
}

export function MobileBottomNavigation({
  label,
  items,
  moreItems,
  account,
}: {
  label: string;
  items: readonly MobileNavigationItem[];
  moreItems: readonly MobileNavigationItem[];
  account?: ReactNode;
}) {
  const [moreOpen, setMoreOpen] = useState(false);
  const { pathname } = useLocation();
  const moreIsActive = moreItems.some((item) => isItemActive(pathname, item));

  useEffect(() => {
    if (!moreOpen) return;
    const desktop = window.matchMedia("(min-width: 768px)");
    function closeAtDesktop(event: MediaQueryListEvent) {
      if (event.matches) setMoreOpen(false);
    }
    desktop.addEventListener("change", closeAtDesktop);
    return () => desktop.removeEventListener("change", closeAtDesktop);
  }, [moreOpen]);

  return (
    <Sheet open={moreOpen} onOpenChange={setMoreOpen}>
      <nav
        aria-label={label}
        className="fixed inset-x-0 bottom-0 z-40 border-t border-red-100 bg-white/95 px-2 pb-[env(safe-area-inset-bottom)] shadow-[0_-4px_18px_rgba(15,23,42,0.08)] backdrop-blur dark:border-gray-800 dark:bg-gray-950/95 md:hidden"
      >
        <ul
          className="grid min-h-16 items-stretch gap-1"
          style={{
            gridTemplateColumns: `repeat(${items.length + 1}, minmax(0, 1fr))`,
          }}
        >
          {items.map(({ to, label: itemLabel, Icon, end }) => (
            <li key={to} className="min-w-0">
              <NavLink
                to={to}
                end={end}
                className={({ isActive }) =>
                  `flex min-h-14 min-w-0 flex-col items-center justify-center gap-1 rounded-lg px-1 py-1 text-[0.68rem] font-semibold leading-none focus:outline-none focus-visible:ring-2 focus-visible:ring-red-700 ${
                    isActive
                      ? "text-red-800"
                      : "text-gray-500 hover:bg-red-50 hover:text-red-800"
                  }`
                }
              >
                <Icon aria-hidden="true" className="size-5 shrink-0" />
                <span className="max-w-full truncate">{itemLabel}</span>
              </NavLink>
            </li>
          ))}
          <li className="min-w-0">
            <SheetTrigger asChild>
              <button
                type="button"
                aria-label="More destinations"
                aria-controls="ioio-mobile-more-navigation"
                aria-expanded={moreOpen}
                aria-pressed={moreIsActive}
                className={`flex min-h-14 w-full min-w-0 flex-col items-center justify-center gap-1 rounded-lg p-1 text-[0.68rem] font-semibold leading-none focus:outline-none focus-visible:ring-2 focus-visible:ring-red-700 ${
                  moreIsActive || moreOpen
                    ? "text-red-800"
                    : "text-gray-500 hover:bg-red-50 hover:text-red-800"
                }`}
              >
                <MoreHorizontal aria-hidden="true" className="size-5" />
                <span>More</span>
              </button>
            </SheetTrigger>
          </li>
        </ul>
      </nav>

      <SheetContent
        id="ioio-mobile-more-navigation"
        side="bottom"
        hideCloseButton
        overlayClassName="bg-black/55 motion-reduce:animate-none"
        className="motion-reduce:animate-none flex max-h-[min(80dvh,calc(100dvh-env(safe-area-inset-top)-1rem))] w-full flex-col gap-0 overflow-hidden rounded-t-2xl border-red-100 bg-white p-0 pb-[env(safe-area-inset-bottom)] text-gray-900 data-[state=closed]:duration-200 data-[state=open]:duration-300 dark:border-gray-800 dark:bg-gray-950 dark:text-gray-50"
      >
        <SheetHeader className="flex shrink-0 flex-row items-center justify-between gap-3 space-y-0 border-b border-gray-100 py-1.5 pl-[max(1rem,env(safe-area-inset-left))] pr-[max(0.75rem,env(safe-area-inset-right))] text-left dark:border-gray-800">
          <SheetTitle className="text-base text-gray-950 dark:text-gray-50">
            More
          </SheetTitle>
          <SheetDescription className="sr-only">
            Choose a navigation destination.
          </SheetDescription>
          <SheetClose asChild>
            <button
              type="button"
              aria-label="Close"
              className="inline-flex size-11 shrink-0 items-center justify-center rounded-full bg-gray-100 text-gray-700 transition-colors hover:bg-gray-200 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-red-700 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
            >
              <X aria-hidden="true" className="size-5" />
            </button>
          </SheetClose>
        </SheetHeader>
        <div className="min-h-0 min-w-0 touch-pan-y overflow-y-auto overscroll-contain pb-3 pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] pt-2">
          <nav aria-label="More destinations" className="space-y-2">
            {groupNavigation(moreItems).map(({ heading, items: links }) => (
              <div key={links[0].to}>
                {heading ? (
                  <h3 className="px-2 pb-0.5 text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                    {heading}
                  </h3>
                ) : null}
                <ul>
                  {links.map((item) => {
                    const { to, label: itemLabel, Icon } = item;
                    const active = isItemActive(pathname, item);
                    return (
                      <li key={to}>
                        <SheetClose asChild>
                          <Link
                            to={to}
                            aria-current={active ? "page" : undefined}
                            className={`grid min-h-11 w-full grid-cols-[1.125rem_minmax(0,1fr)_1rem] items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-red-700 ${
                              active
                                ? "bg-red-50 text-red-800 dark:bg-red-950/50 dark:text-red-200"
                                : "text-gray-700 hover:bg-gray-50 dark:text-gray-200 dark:hover:bg-gray-800"
                            }`}
                          >
                            <Icon aria-hidden="true" className="size-[18px]" />
                            <span className="min-w-0 [overflow-wrap:anywhere]">
                              {itemLabel}
                            </span>
                            <ChevronRight
                              aria-hidden="true"
                              className="size-4 justify-self-end text-gray-400 dark:text-gray-500"
                            />
                          </Link>
                        </SheetClose>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </nav>
          {account}
        </div>
      </SheetContent>
    </Sheet>
  );
}
