import type { ReactNode } from "react";
import { tw } from "~/utils/tw";

export function IoioPageContainer({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <main
      className={tw(
        "mx-auto box-border w-full min-w-0 max-w-full px-4",
        className
      )}
    >
      {children}
    </main>
  );
}
