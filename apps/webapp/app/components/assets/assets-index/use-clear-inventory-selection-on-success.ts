import { useEffect, useRef } from "react";
import type { MutableRefObject } from "react";
import { useSetAtom } from "jotai";
import { removeSelectedBulkItemsAtom } from "~/atoms/list";
import type { ListItemData } from "~/components/list/list-item";

/**
 * Remove the selection captured for a visibility request only after its
 * successful idle response. A failed request leaves the selection available
 * for correction and retry.
 */
export function useClearInventorySelectionOnSuccess({
  data,
  state,
  pendingSelectionRef,
}: {
  data: { success?: boolean } | undefined;
  state: string;
  pendingSelectionRef: MutableRefObject<ListItemData[] | null>;
}) {
  const removeSelectedItems = useSetAtom(removeSelectedBulkItemsAtom);
  const lastHandledResponseRef = useRef<unknown>(null);

  useEffect(() => {
    const submittedSelection = pendingSelectionRef.current;
    if (
      state !== "idle" ||
      !data?.success ||
      !submittedSelection ||
      data === lastHandledResponseRef.current
    ) {
      return;
    }

    lastHandledResponseRef.current = data;
    pendingSelectionRef.current = null;
    removeSelectedItems(submittedSelection);
  }, [data, pendingSelectionRef, removeSelectedItems, state]);
}
