import { createElement, Fragment, useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it, vi } from "vitest";
import type { IoioLocation } from "./ioio-location-hierarchy";
import { IoioLocationHierarchy } from "./ioio-location-hierarchy";

vi.mock("~/hooks/search-params", async () => {
  const router = await vi.importActual("react-router");
  return { useSearchParams: router.useSearchParams };
});

function location(id: string, name: string, parentId: string | null) {
  return {
    id,
    name,
    parentId,
    color: null,
    _count: { children: 0, assetLocations: 0, kits: 0 },
  } as unknown as IoioLocation;
}

const locations = [
  location("room", "Room B477", null),
  location("section", "Section A", "room"),
  location("shelf-a1", "Shelf A1", "section"),
  location("shelf-a2", "Shelf A2", "section"),
  location("shelf-a3", "Shelf A3", "section"),
];
const inventorySummary = {
  containerAssetCounts: {},
  rooms: {},
  sections: {},
  unassignedOrIncompleteAssetCount: 0,
};

function renderHierarchy({
  selectedId = "shelf-a1",
  allowShelfRemoval = false,
}: { selectedId?: string; allowShelfRemoval?: boolean } = {}) {
  const submitted = vi.fn();
  const router = createMemoryRouter(
    [
      {
        path: "/locations",
        action: async ({ request }) => {
          submitted(Object.fromEntries((await request.formData()).entries()));
          return {
            success: true,
            location: { id: "created", name: "Created", parentId: "shelf-a2" },
          };
        },
        element: createElement(HierarchyHarness, { allowShelfRemoval }),
      },
    ],
    {
      initialEntries: [
        `/locations?room=room&section=section&selectedLocation=${selectedId}`,
      ],
    }
  );
  render(createElement(RouterProvider, { router }));
  return submitted;
}

function HierarchyHarness({
  allowShelfRemoval,
}: {
  allowShelfRemoval: boolean;
}) {
  const [currentLocations, setCurrentLocations] = useState(locations);
  return createElement(
    Fragment,
    null,
    allowShelfRemoval
      ? createElement(
          "button",
          {
            type: "button",
            onClick: () =>
              setCurrentLocations((current) =>
                current.filter((location) => location.id !== "shelf-a1")
              ),
          },
          "Remove shelf A1"
        )
      : null,
    createElement(IoioLocationHierarchy, {
      locations: currentLocations,
      inventorySummary,
    })
  );
}

async function startContainerForm(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Add container" }));
  expect(
    await screen.findByText("Adding container under Shelf A1")
  ).toBeTruthy();
}

describe("IOIO location hierarchy inline creation", () => {
  it("submits under the live selected shelf after changing A1 to A2 with the form open", async () => {
    const user = userEvent.setup();
    const submitted = renderHierarchy();
    await startContainerForm(user);

    await user.click(screen.getByRole("button", { name: "Shelf A2" }));
    expect(
      await screen.findByText("Adding container under Shelf A2")
    ).toBeTruthy();
    expect(screen.getByLabelText("Container name")).toBeInTheDocument();
    expect(
      screen
        .getByLabelText("Container name")
        .closest("form")
        ?.querySelector('input[name="parentId"]')
    ).toHaveValue("shelf-a2");

    await user.type(screen.getByLabelText("Container name"), "Container A2-2");
    await user.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(submitted).toHaveBeenCalledOnce());
    expect(submitted).toHaveBeenCalledWith({
      intent: "inline-create",
      locationType: "container",
      parentId: "shelf-a2",
      name: "Container A2-2",
    });
  });

  it("tracks A1 to A2 to A3 without cancelling or reopening the form", async () => {
    const user = userEvent.setup();
    const submitted = renderHierarchy();
    await startContainerForm(user);

    await user.click(screen.getByRole("button", { name: "Shelf A2" }));
    expect(
      await screen.findByText("Adding container under Shelf A2")
    ).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Shelf A3" }));
    expect(
      await screen.findByText("Adding container under Shelf A3")
    ).toBeTruthy();
    expect(screen.getByLabelText("Container name")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Cancel" })
    ).toBeInTheDocument();

    await user.type(screen.getByLabelText("Container name"), "Container A3-1");
    await user.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(submitted).toHaveBeenCalledOnce());
    expect(submitted.mock.calls[0]?.[0]).toMatchObject({
      parentId: "shelf-a3",
      name: "Container A3-1",
    });
  });

  it("disables container submission if the selected shelf disappears", async () => {
    const user = userEvent.setup();
    renderHierarchy({ allowShelfRemoval: true });
    await user.click(screen.getByRole("button", { name: "Add container" }));
    await screen.findByText("Adding container under Shelf A1");
    await user.click(screen.getByRole("button", { name: "Remove shelf A1" }));
    expect(
      await screen.findByText("Select a shelf before adding a container.")
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
  });

  it.each([
    { selectedId: "shelf-a1", type: "room", parentId: "", name: "Room name" },
    {
      selectedId: "room",
      type: "section",
      parentId: "room",
      name: "Section name",
    },
    {
      selectedId: "section",
      type: "shelf",
      parentId: "section",
      name: "Shelf name",
    },
  ])(
    "keeps normal $type creation parent behavior",
    async ({ selectedId, type, parentId, name }) => {
      const user = userEvent.setup();
      const submitted = renderHierarchy({ selectedId });
      await user.click(screen.getByRole("button", { name: `Add ${type}` }));
      await user.type(screen.getByLabelText(name), `New ${type}`);
      await user.click(screen.getByRole("button", { name: "Add" }));
      await waitFor(() => expect(submitted).toHaveBeenCalledOnce());
      expect(submitted.mock.calls[0]?.[0]).toMatchObject({
        locationType: type,
        parentId,
        name: `New ${type}`,
      });
    }
  );
});
