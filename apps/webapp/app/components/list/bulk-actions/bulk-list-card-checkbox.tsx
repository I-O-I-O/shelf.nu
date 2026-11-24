import { useAtomValue, useSetAtom } from "jotai";
import {
  bulkSelectionKey,
  disabledBulkItemsAtom,
  removeSelectedBulkItemsAtom,
  selectedBulkItemsAtom,
  setSelectedBulkItemAtom,
} from "~/atoms/list";
import { FakeCheckbox } from "~/components/forms/fake-checkbox";
import type { ListItemData } from "../list-item";

/** Card-sized counterpart to `BulkListItemCheckbox`, for narrow list views. */
export function BulkListCardCheckbox({ item }: { item: ListItemData }) {
  const selectedBulkItems = useAtomValue(selectedBulkItemsAtom);
  const disabledBulkItems = useAtomValue(disabledBulkItemsAtom);
  const setSelectedBulkItem = useSetAtom(setSelectedBulkItemAtom);
  const removeSelectedBulkItems = useSetAtom(removeSelectedBulkItemsAtom);

  const itemKey = bulkSelectionKey(item);
  const disabled = disabledBulkItems.some(
    (disabledItem) => bulkSelectionKey(disabledItem) === itemKey
  );
  const checked = selectedBulkItems.some(
    (selectedItem) => bulkSelectionKey(selectedItem) === itemKey
  );
  const itemName =
    (typeof item.title === "string" && item.title) ||
    (typeof item.name === "string" && item.name) ||
    "item";

  return (
    <button
      type="button"
      aria-label={`${checked ? "Deselect" : "Select"} ${itemName}`}
      aria-pressed={checked}
      disabled={disabled}
      onClick={() => {
        if (checked) {
          removeSelectedBulkItems([item]);
        } else {
          setSelectedBulkItem(item);
        }
      }}
      className="flex size-11 shrink-0 items-center justify-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 disabled:cursor-not-allowed"
    >
      <FakeCheckbox
        checked={checked}
        className={checked ? "text-primary" : "text-white"}
      />
    </button>
  );
}
