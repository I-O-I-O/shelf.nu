import { useState } from "react";

/** Edits Shelf's canonical borrowing flag without changing visibility or status. */
export function BorrowabilityField({
  availableToBook,
  disabled,
  onBorrowableChange,
}: {
  availableToBook: boolean;
  disabled?: boolean;
  onBorrowableChange?: (borrowable: boolean) => void;
}) {
  const [borrowable, setBorrowable] = useState(availableToBook);
  const [changed, setChanged] = useState(false);
  return (
    <div>
      {changed ? (
        <input
          type="hidden"
          name="availableToBook"
          value={String(borrowable)}
        />
      ) : null}
      <label className="flex items-center gap-2 text-sm font-medium text-gray-900">
        <input
          type="checkbox"
          checked={!borrowable}
          disabled={disabled}
          onChange={(event) => {
            setBorrowable(!event.target.checked);
            onBorrowableChange?.(!event.target.checked);
            setChanged(true);
          }}
        />
        Can't borrow
      </label>
      <p className="mt-1 text-xs text-gray-600">
        {borrowable
          ? "Keep this item visible in inventory, but prevent borrowing and reservations."
          : "Lab use only — this item cannot be borrowed."}
      </p>
    </div>
  );
}
