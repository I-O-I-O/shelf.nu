import type { MutableRefObject, ReactNode } from "react";
import { act, renderHook } from "@testing-library/react";
import { createStore, Provider } from "jotai";
import { describe, expect, it } from "vitest";
import { selectedBulkItemsAtom } from "~/atoms/list";
import type { ListItemData } from "~/components/list/list-item";
import { useClearInventorySelectionOnSuccess } from "./use-clear-inventory-selection-on-success";

type FetcherResponse = { success?: boolean; hidden?: boolean } | undefined;
type HookProps = { data: FetcherResponse; state: string };

describe("useClearInventorySelectionOnSuccess", () => {
  it.each([true, false])(
    "clears the submitted selection after successful visibility change hidden=%s",
    (hidden) => {
      const store = createStore();
      const submitted = { id: "asset-submitted" };
      const newlySelected = { id: "asset-new" };
      const pendingSelectionRef = {
        current: [submitted],
      } as MutableRefObject<ListItemData[] | null>;
      const wrapper = ({ children }: { children: ReactNode }) => (
        <Provider store={store}>{children}</Provider>
      );
      const hook = renderHook(
        ({ data, state }: HookProps) =>
          useClearInventorySelectionOnSuccess({
            data,
            state,
            pendingSelectionRef,
          }),
        {
          initialProps: { data: undefined, state: "idle" } as HookProps,
          wrapper,
        }
      );

      act(() => {
        store.set(selectedBulkItemsAtom, [submitted, newlySelected]);
      });
      hook.rerender({ data: { success: true, hidden }, state: "idle" });

      expect(store.get(selectedBulkItemsAtom)).toEqual([newlySelected]);
      expect(pendingSelectionRef.current).toBeNull();
    }
  );

  it("keeps the selected items when visibility change fails", () => {
    const store = createStore();
    const submitted = { id: "asset-submitted" };
    const pendingSelectionRef = {
      current: [submitted],
    } as MutableRefObject<ListItemData[] | null>;
    const wrapper = ({ children }: { children: ReactNode }) => (
      <Provider store={store}>{children}</Provider>
    );
    const hook = renderHook(
      ({ data, state }: HookProps) =>
        useClearInventorySelectionOnSuccess({
          data,
          state,
          pendingSelectionRef,
        }),
      {
        initialProps: { data: undefined, state: "idle" } as HookProps,
        wrapper,
      }
    );

    act(() => store.set(selectedBulkItemsAtom, [submitted]));
    hook.rerender({ data: { success: false }, state: "idle" });

    expect(store.get(selectedBulkItemsAtom)).toEqual([submitted]);
    expect(pendingSelectionRef.current).toEqual([submitted]);
  });
});
