import type { ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { Link } from "react-router";

type PageBackLinkProps = {
  to: string;
  children: ReactNode;
  className?: string;
};

/** Lightweight page navigation aligned to the outer edge of the content column. */
export function PageBackLink({
  to,
  children,
  className = "",
}: PageBackLinkProps) {
  return (
    <Link
      to={to}
      className={`block w-fit text-sm font-semibold text-red-700 transition-colors hover:text-red-800 focus-visible:rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-700 lg:-ml-8 ${className}`}
    >
      <span className="inline-flex items-center gap-1.5">
        <ArrowLeft aria-hidden="true" className="size-4 shrink-0" />
        {children}
      </span>
    </Link>
  );
}
