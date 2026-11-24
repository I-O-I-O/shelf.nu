import { act, fireEvent, render, screen } from "@testing-library/react";
import { Provider, createStore, useAtomValue } from "jotai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { bulkDialogAtom } from "~/atoms/bulk-update-dialog";
import { selectedBulkItemsAtom } from "~/atoms/list";
import { CategorySelectionToolbar } from "./category-selection-toolbar";

const categoryItems = vi.hoisted(() =>
  Array.from({ length: 7 }, (_, index) => ({
    id: `category-${index + 1}`,
  }))
);

// why: this component gets the visible categories from its route loader; the
// test supplies a small deterministic list without mounting the route.
vi.mock("react-router", async (importOriginal) => ({
  ...(await importOriginal()),
  useLoaderData: () => ({
    items: categoryItems,
    totalItems: categoryItems.length,
  }),
}));

// why: the test verifies the toolbar controls and dialog trigger state; the
// existing confirmation form is covered by its shared bulk-dialog behavior.
vi.mock("./bulk-delete-dialog", () => ({ default: () => null }));

function SelectionProbe() {
  const selected = useAtomValue(selectedBulkItemsAtom);
  const bulkDialog = useAtomValue(bulkDialogAtom);
  return (
    <output data-testid="selection-state">
      {selected.map((item) => item.id).join(",")}|{String(bulkDialog.trash)}
    </output>
  );
}

describe("CategorySelectionToolbar", () => {
  let store: ReturnType<typeof createStore>;

  beforeEach(() => {
    store = createStore();
  });

  it("offers concise selection actions and selects all categories", () => {
    render(
      <Provider store={store}>
        <CategorySelectionToolbar />
        <SelectionProbe />
      </Provider>
    );
    act(() => {
      store.set(selectedBulkItemsAtom, [categoryItems[0], categoryItems[1]]);
    });

    expect(screen.getByText("2 selected")).toBeInTheDocument();
    const selectAllButton = screen.getByRole("button", { name: "Select all" });
    const cancelButton = screen.getByRole("button", { name: "Cancel" });
    const deleteButton = screen.getByRole("button", {
      name: "Delete selected",
    });
    const toolbar = screen.getByText("2 selected").parentElement?.parentElement;
    const leftSide = toolbar?.firstElementChild;
    expect(leftSide?.firstElementChild).toHaveTextContent("2 selected");
    expect(Array.from(leftSide?.querySelectorAll("button") ?? [])).toEqual([
      selectAllButton,
      cancelButton,
    ]);
    expect(toolbar?.lastElementChild).toContainElement(deleteButton);
    expect(
      screen.queryByLabelText("Clear selected items")
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Select all" }));

    expect(screen.getByText("7 selected")).toBeInTheDocument();
    expect(store.get(selectedBulkItemsAtom)).toEqual([
      ...categoryItems,
      { id: "all-selected" },
    ]);
  });

  it("opens the existing delete confirmation", () => {
    render(
      <Provider store={store}>
        <CategorySelectionToolbar />
        <SelectionProbe />
      </Provider>
    );
    act(() => {
      store.set(selectedBulkItemsAtom, [categoryItems[0], categoryItems[1]]);
    });

    fireEvent.click(screen.getByRole("button", { name: "Delete selected" }));
    expect(store.get(bulkDialogAtom).trash).toBe(true);
  });

  it("Cancel clears the selection", () => {
    render(
      <Provider store={store}>
        <CategorySelectionToolbar />
        <SelectionProbe />
      </Provider>
    );
    act(() => {
      store.set(selectedBulkItemsAtom, [categoryItems[0], categoryItems[1]]);
    });

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(store.get(selectedBulkItemsAtom)).toEqual([]);
  });
});
