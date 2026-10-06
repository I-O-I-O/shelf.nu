import type { MouseEvent, ReactNode } from "react";

type SelectableRowProps = {
  children: ReactNode;
  selected: boolean;
  onToggle?: () => void;
  className?: string;
  variant?: "card" | "list";
};

const INTERACTIVE_DESCENDANT_SELECTOR =
  'a, button, input, select, textarea, summary, form, [role="button"], [role="menuitem"], [contenteditable="true"], [data-selection-exempt]';

/**
 * Adds a large pointer/touch target to an existing checkbox-selected row.
 * The checkbox remains the keyboard-accessible selection control.
 */
export function SelectableRow({
  children,
  selected,
  onToggle,
  className = "",
  variant = "card",
}: SelectableRowProps) {
  function handleClick(event: MouseEvent<HTMLElement>) {
    if (!onToggle) return;
    const target = event.target;
    if (
      target instanceof Element &&
      target.closest(INTERACTIVE_DESCENDANT_SELECTOR)
    ) {
      return;
    }
    onToggle();
  }

  const surfaceClasses =
    variant === "list"
      ? `border-b border-gray-200 transition-colors ${
          onToggle
            ? selected
              ? "cursor-pointer bg-red-50/60"
              : "cursor-pointer bg-white hover:bg-red-50/30"
            : "bg-white"
        }`
      : `rounded-2xl border p-4 shadow-sm transition-colors ${
          onToggle
            ? selected
              ? "cursor-pointer border-red-200 bg-red-50/60"
              : "cursor-pointer border-gray-200 bg-white hover:border-red-200 hover:bg-red-50/30"
            : "border-gray-200 bg-white"
        }`;

  return (
    <article
      onClick={onToggle ? handleClick : undefined}
      className={`${surfaceClasses} ${className}`}
    >
      {children}
    </article>
  );
}

export function toggleSelectionId(current: string[], id: string) {
  return current.includes(id)
    ? current.filter((selectedId) => selectedId !== id)
    : [...current, id];
}
