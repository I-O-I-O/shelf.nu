import type { ReactNode } from "react";

export function StaffInventoryMobileCard({
  selectionControl,
  image,
  title,
  status,
  expandControl,
  actions,
  category,
  location,
  availability,
  expandedContent,
}: {
  selectionControl: ReactNode;
  image: ReactNode;
  title: ReactNode;
  status?: ReactNode;
  expandControl?: ReactNode;
  actions: ReactNode;
  category: ReactNode;
  location: ReactNode;
  availability: ReactNode;
  expandedContent?: ReactNode;
}) {
  return (
    <article className="w-full min-w-0 space-y-3 p-3">
      <header className="flex min-w-0 items-start gap-1.5">
        <div className="flex size-11 shrink-0 items-center justify-center">
          {selectionControl}
        </div>
        <div className="flex size-12 shrink-0 items-center justify-center">
          {image}
        </div>
        <div className="min-w-0 flex-1 pt-0.5">
          <div className="min-w-0 break-words text-base font-semibold leading-snug text-gray-950">
            {title}
          </div>
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5">
            {availability}
            {status}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {expandControl}
          {actions}
        </div>
      </header>

      <dl className="grid min-w-0 grid-cols-1 gap-3 border-t border-gray-100 pt-3 text-sm min-[390px]:grid-cols-2">
        <div className="min-w-0">
          <dt className="text-xs font-medium uppercase tracking-wide text-gray-400">
            Category
          </dt>
          <dd className="mt-1 min-w-0 break-words">{category}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs font-medium uppercase tracking-wide text-gray-400">
            Location
          </dt>
          <dd className="mt-1 min-w-0 break-words">{location}</dd>
        </div>
      </dl>

      {expandedContent ? (
        <div className="rounded-lg bg-gray-50 p-3">{expandedContent}</div>
      ) : null}
    </article>
  );
}
