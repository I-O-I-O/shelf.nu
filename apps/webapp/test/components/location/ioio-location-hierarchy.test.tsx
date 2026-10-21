import { createElement } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  createMemoryRouter,
  Outlet,
  RouterProvider,
  data,
  useLoaderData,
} from "react-router";
import { describe, expect, it, vi } from "vitest";
import type { IoioLocation } from "~/components/location/ioio-location-hierarchy";
import { IoioLocationHierarchy } from "~/components/location/ioio-location-hierarchy";
import type { IoioLocationInventorySummary } from "~/modules/location/ioio-hierarchy";

// why: location images and permissions are presentation-independent UI boundaries.
vi.mock("~/components/image-with-preview/image-with-preview", () => ({
  default: ({ alt }: { alt: string }) => <img alt={alt} />,
}));
vi.mock("~/components/location/location-quick-actions", () => ({
  default: () => <button type="button">Location actions</button>,
}));
// why: the app wrapper adds organization cookie behavior; this explorer test only
// needs React Router's URL state and data-router navigation.
vi.mock("~/hooks/search-params", async (importOriginal) => {
  const router = await importOriginal();
  return { useSearchParams: router.useSearchParams };
});

type ExplorerData = {
  locations: IoioLocation[];
  inventorySummary: IoioLocationInventorySummary;
};

const inventorySummary: IoioLocationInventorySummary = {
  containerAssetCounts: {
    "container-a1-13": 5,
    "container-a1-14": 2,
    "container-a2-01": 3,
    "container-b1-01": 4,
    "container-b478-01": 3,
  },
  rooms: {
    "room-b477": { sections: 3, shelves: 3, containers: 3, assets: 11 },
    "room-b478": { sections: 1, shelves: 1, containers: 1, assets: 0 },
  },
  sections: {
    "section-a": { shelves: 2, containers: 2, assets: 7 },
    "section-b": { shelves: 1, containers: 1, assets: 4 },
    "section-c": { shelves: 0, containers: 0, assets: 0 },
    "section-b478": { shelves: 1, containers: 1, assets: 0 },
  },
  unassignedOrIncompleteAssetCount: 0,
};

function makeLocations(): IoioLocation[] {
  const rows = [
    { id: "room-b477", name: "IOIO Lab - B477", parentId: null },
    { id: "room-b478", name: "IOIO Lab - B478", parentId: null },
    { id: "section-a", name: "Section A", parentId: "room-b477" },
    { id: "section-b", name: "Section B", parentId: "room-b477" },
    { id: "section-c", name: "Section C", parentId: "room-b477" },
    { id: "section-b478", name: "Section B", parentId: "room-b478" },
    { id: "shelf-a1", name: "Shelf A1", parentId: "section-a" },
    { id: "shelf-a2", name: "Shelf A2", parentId: "section-a" },
    { id: "shelf-b1", name: "Shelf B1", parentId: "section-b" },
    { id: "shelf-b478", name: "Shelf B1", parentId: "section-b478" },
    {
      id: "container-b478-01",
      name: "Container B1-01",
      parentId: "shelf-b478",
    },
    {
      id: "container-a1-13",
      name: "Container A1-13",
      parentId: "shelf-a1",
    },
    {
      id: "container-a1-14",
      name: "Container A1-14",
      parentId: "shelf-a1",
    },
    {
      id: "container-a2-01",
      name: "Container A2-01",
      parentId: "shelf-a2",
    },
    {
      id: "container-b1-01",
      name: "Container B1-01",
      parentId: "shelf-b1",
    },
  ];
  return rows.map((row) => {
    const parent = rows.find((candidate) => candidate.id === row.parentId);
    const children = rows.filter((candidate) => candidate.parentId === row.id);
    return {
      ...row,
      parent: parent
        ? {
            id: parent.id,
            name: parent.name,
            parentId: parent.parentId,
            _count: {
              children: rows.filter(
                (candidate) => candidate.parentId === parent.id
              ).length,
            },
          }
        : null,
      imageUrl: null,
      thumbnailUrl: null,
      image: null,
      color: null,
      _count: {
        children: children.length,
        assetLocations:
          row.id === "shelf-a1"
            ? 7
            : row.id === "container-a1-13"
            ? 5
            : row.id === "container-a1-14"
            ? 2
            : 0,
        kits: 0,
      },
    } as unknown as IoioLocation;
  });
}

function ExplorerRoute({ locations }: { locations: IoioLocation[] }) {
  const data = useLoaderData() as ExplorerData;
  return (
    <IoioLocationHierarchy
      locations={data.locations ?? locations}
      inventorySummary={data.inventorySummary ?? inventorySummary}
    />
  );
}

async function renderExplorer(
  initialEntry = "/locations",
  options: {
    empty?: boolean;
    failCreate?: boolean;
    deferRevalidation?: boolean;
  } = {}
) {
  let locations = options.empty ? [] : makeLocations();
  let loaderCalls = 0;
  let finishRevalidation: (() => void) | undefined;
  const pendingRevalidation = new Promise<void>((resolve) => {
    finishRevalidation = resolve;
  });
  const createCalls: Array<{
    name: string;
    parentId: string | null;
    type: string;
  }> = [];
  const router = createMemoryRouter(
    [
      {
        path: "/locations",
        element: createElement(Outlet),
        children: [
          {
            index: true,
            loader: async () => {
              loaderCalls += 1;
              if (options.deferRevalidation && loaderCalls > 1) {
                await pendingRevalidation;
              }
              return { locations, inventorySummary };
            },
            action: async ({ request }) => {
              const formData = await request.formData();
              if (options.failCreate) {
                return data(
                  { error: { message: "Location could not be created." } },
                  { status: 400 }
                );
              }
              const created = {
                id: `created-${createCalls.length + 1}`,
                name: String(formData.get("name")),
                parentId: String(formData.get("parentId")) || null,
              };
              createCalls.push({
                name: created.name,
                parentId: created.parentId,
                type: String(formData.get("locationType")),
              });
              locations = [
                ...locations,
                {
                  ...created,
                  parent: null,
                  imageUrl: null,
                  thumbnailUrl: null,
                  image: null,
                  color: null,
                  _count: { children: 0, assetLocations: 0, kits: 0 },
                } as unknown as IoioLocation,
              ];
              return { success: true, location: created };
            },
            element: createElement(ExplorerRoute, { locations }),
          },
        ],
      },
    ],
    { initialEntries: [initialEntry] }
  );
  render(createElement(RouterProvider, { router }));
  await screen.findByRole("searchbox", {
    name: "Search rooms, sections, shelves, or containers",
  });
  return {
    router,
    createCalls,
    getLoaderCalls: () => loaderCalls,
    finishRevalidation: () => finishRevalidation?.(),
  };
}

describe("IOIO Location Explorer", () => {
  it("shows all Section containers grouped by Shelf without selecting a Shelf", async () => {
    const user = userEvent.setup();
    await renderExplorer("/locations");

    expect(
      screen.queryByRole("heading", { name: "Locations" })
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "IOIO Lab - B477" })
    ).toHaveAttribute("aria-pressed", "true");
    expect(screen.getAllByRole("button", { name: /^Section / })).toHaveLength(
      3
    );
    expect(
      within(screen.getByRole("region", { name: "shelves" })).getByText(
        "Select a section first."
      )
    ).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Section A" }));
    expect(screen.getAllByRole("button", { name: /^Shelf / })).toHaveLength(2);
    const containers = screen.getByRole("region", { name: "containers" });
    expect(
      within(containers).getByRole("button", { name: "Container A1-13" })
    ).toBeVisible();
    expect(
      within(containers).getByRole("button", { name: "Container A1-14" })
    ).toBeVisible();
    expect(
      within(containers).getByRole("button", { name: "Container A2-01" })
    ).toBeVisible();
    expect(within(containers).queryByText("Select a shelf first.")).toBeNull();
    expect(within(containers).getByText("Shelf A1")).toBeVisible();
    expect(within(containers).getByText("Shelf A2")).toBeVisible();
    expect(screen.getByText("5 assets")).toBeVisible();
    expect(screen.queryByText(/Shelf A1.*\d+ assets?/)).not.toBeInTheDocument();
  });

  it("asks for a Shelf before creating a Container when a Section has multiple Shelves", async () => {
    const user = userEvent.setup();
    const { createCalls } = await renderExplorer("/locations");
    await user.click(screen.getByRole("button", { name: "Section A" }));
    await user.click(screen.getByRole("button", { name: "Add container" }));

    const chooser = screen.getByLabelText("Choose a shelf");
    await user.click(within(chooser).getByRole("button", { name: "Shelf A2" }));
    const input = screen.getByRole("textbox", { name: "Container name" });
    await user.type(input, "Container A2-02");
    await user.click(screen.getByRole("button", { name: "Add", exact: true }));
    await waitFor(() => expect(createCalls).toHaveLength(1));
    expect(createCalls[0]).toMatchObject({
      name: "Container A2-02",
      parentId: "shelf-a2",
      type: "container",
    });
  });

  it("uses the only Shelf in a Section as the Container creation parent", async () => {
    const user = userEvent.setup();
    const { createCalls } = await renderExplorer("/locations");
    await user.click(screen.getByRole("button", { name: "Section B" }));
    await user.click(screen.getByRole("button", { name: "Add container" }));
    const input = screen.getByRole("textbox", { name: "Container name" });
    await user.type(input, "Container B1-02");
    await user.keyboard("{Enter}");

    await waitFor(() => expect(createCalls).toHaveLength(1));
    expect(createCalls[0]).toMatchObject({
      name: "Container B1-02",
      parentId: "shelf-b1",
      type: "container",
    });
  });

  it("shows Section-level empty states when there are no Shelves or Containers", async () => {
    await renderExplorer(
      "/locations?room=room-b477&section=section-c&selectedLocation=section-c"
    );

    expect(
      within(screen.getByRole("region", { name: "shelves" })).getByText(
        "No shelves yet."
      )
    ).toBeVisible();
    const containers = screen.getByRole("region", { name: "containers" });
    expect(within(containers).getByText("No containers yet.")).toBeVisible();
    expect(within(containers).queryByText("Select a shelf first.")).toBeNull();
  });

  it("filters each level by its selected parent", async () => {
    const user = userEvent.setup();
    await renderExplorer("/locations");

    await user.click(screen.getByRole("button", { name: "IOIO Lab - B478" }));
    expect(screen.getAllByRole("button", { name: /^Section / })).toHaveLength(
      1
    );
    expect(screen.getByRole("button", { name: "Section B" })).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Section A" })
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Section B" }));
    expect(screen.getByRole("button", { name: "Shelf B1" })).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Shelf A1" })
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Shelf B1" }));
    expect(screen.getByText("3 assets")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Container A1-13" })
    ).not.toBeInTheDocument();
  });

  it("disables child creation until the required parent is selected", async () => {
    await renderExplorer(
      "/locations?room=room-b477&selectedLocation=room-b477"
    );
    expect(screen.getByRole("button", { name: "Add section" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Add shelf" })).toBeDisabled();
    expect(
      within(screen.getByRole("region", { name: "shelves" })).getByText(
        "Select a section first."
      )
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Add container" })
    ).toBeDisabled();
  });

  it("disables Section creation when there is no Room", async () => {
    await renderExplorer("/locations", { empty: true });
    expect(screen.getByRole("button", { name: "Add section" })).toBeDisabled();
    expect(
      within(screen.getByRole("region", { name: "sections" })).getByText(
        "Select a room first."
      )
    ).toBeVisible();
  });

  it("keeps all four level groups independently collapsible", async () => {
    const user = userEvent.setup();
    await renderExplorer("/locations");

    await user.click(screen.getByRole("button", { name: "Collapse sections" }));
    expect(
      screen.queryByRole("button", { name: "Section A" })
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Collapse rooms" })
    ).toHaveAttribute("aria-expanded", "true");
    await user.click(screen.getByRole("button", { name: "Expand sections" }));
    expect(screen.getByRole("button", { name: "Section A" })).toBeVisible();
  });

  it("shows counts only for containers", async () => {
    await renderExplorer(
      "/locations?room=room-b477&section=section-a&selectedLocation=container-a1-13"
    );

    const roomGroup = screen.getByRole("region", { name: "rooms" });
    const sectionGroup = screen.getByRole("region", { name: "sections" });
    const shelfGroup = screen.getByRole("region", { name: "shelves" });
    const containerGroup = screen.getByRole("region", { name: "containers" });
    expect(roomGroup).not.toHaveTextContent(/\d+ assets?/);
    expect(sectionGroup).not.toHaveTextContent(/\d+ assets?/);
    expect(shelfGroup).not.toHaveTextContent(/\d+ assets?/);
    expect(containerGroup).toHaveTextContent("5 assets");
    expect(containerGroup).toHaveTextContent("2 assets");
  });

  it("search selects a result and reveals its full hierarchy path", async () => {
    const user = userEvent.setup();
    await renderExplorer("/locations");
    await user.type(
      screen.getByRole("searchbox", {
        name: "Search rooms, sections, shelves, or containers",
      }),
      "A1-13"
    );
    const result = screen.getByRole("button", {
      name: /Container A1-13.*IOIO Lab - B477 › Section A › Shelf A1/,
    });
    await user.click(result);

    expect(
      screen.getByRole("button", { name: "IOIO Lab - B477" })
    ).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Section A" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    expect(screen.getByRole("button", { name: "Shelf A1" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    expect(
      screen.getByRole("button", { name: /Container A1-13/ })
    ).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByLabelText("Selected path")).toHaveTextContent(
      "IOIO Lab - B477 / Section A / Shelf A1 / Container A1-13"
    );
  });

  it.each([
    ["room", "room-b477", "IOIO Lab - B477", null],
    ["section", "section-a", "IOIO Lab - B477 / Section A", "Section A"],
    [
      "shelf",
      "shelf-a1",
      "IOIO Lab - B477 / Section A / Shelf A1",
      "Section A",
    ],
    [
      "container",
      "container-a1-13",
      "IOIO Lab - B477 / Section A / Shelf A1 / Container A1-13",
      "Section A",
    ],
  ])(
    "resolves a selected %s to its room and ancestors",
    async (_kind, selectedId, path, selectedSection) => {
      await renderExplorer(
        `/locations?room=room-b477&selectedLocation=${selectedId}`
      );

      expect(screen.getByLabelText("Selected path")).toHaveTextContent(path);
      expect(
        screen.getByRole("button", { name: "IOIO Lab - B477" })
      ).toHaveAttribute("aria-pressed", "true");
      if (selectedSection) {
        expect(
          screen.getByRole("button", { name: selectedSection })
        ).toHaveAttribute("aria-pressed", "true");
      }
      if (selectedId === "shelf-a1" || selectedId === "container-a1-13") {
        expect(
          screen.getByRole("button", { name: "Shelf A1" })
        ).toHaveAttribute("aria-pressed", "true");
      }
    }
  );

  it("falls back from a stale selected location to the valid room", async () => {
    await renderExplorer(
      "/locations?room=room-b478&selectedLocation=deleted-location"
    );

    expect(
      screen.getByRole("button", { name: "IOIO Lab - B478" })
    ).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Section B" })).toBeVisible();
    expect(screen.getByLabelText("Selected path")).toHaveTextContent(
      "IOIO Lab - B478"
    );
  });

  it("clears stale section and shelf selections after loader data changes", async () => {
    await renderExplorer(
      "/locations?room=room-b477&section=deleted-section&selectedLocation=deleted-section"
    );

    expect(screen.getByLabelText("Selected path")).toHaveTextContent(
      "IOIO Lab - B477"
    );
    expect(
      screen.getByRole("button", { name: "IOIO Lab - B477" })
    ).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Section A" })).toHaveAttribute(
      "aria-pressed",
      "false"
    );
    expect(screen.getByRole("button", { name: "Add shelf" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Add container" })
    ).toBeDisabled();
    expect(
      within(screen.getByRole("region", { name: "containers" })).queryByRole(
        "button",
        { name: "Container A1-13" }
      )
    ).not.toBeInTheDocument();
  });

  it("uses the selected location path when the room query disagrees", async () => {
    await renderExplorer(
      "/locations?room=room-b478&selectedLocation=container-a1-13"
    );

    expect(screen.getByLabelText("Selected path")).toHaveTextContent(
      "IOIO Lab - B477 / Section A / Shelf A1 / Container A1-13"
    );
    expect(
      screen.getByRole("button", { name: "IOIO Lab - B477" })
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.getByRole("button", { name: "IOIO Lab - B478" })
    ).toHaveAttribute("aria-pressed", "false");
  });

  it.each([
    ["room", "Add room", "Room name", null, "/locations"],
    [
      "section",
      "Add section",
      "Section name",
      "room-b477",
      "/locations?room=room-b477",
    ],
    [
      "shelf",
      "Add shelf",
      "Shelf name",
      "section-a",
      "/locations?room=room-b477&section=section-a",
    ],
    [
      "container",
      "Add container",
      "Container name",
      "shelf-a1",
      "/locations?room=room-b477&section=section-a&selectedLocation=shelf-a1",
    ],
  ])(
    "creates a %s using its level header and selected parent",
    async (type, addName, inputName, parentId, url) => {
      const user = userEvent.setup();
      const { createCalls, getLoaderCalls } = await renderExplorer(url);
      const initialLoaderCalls = getLoaderCalls();
      await user.click(screen.getByRole("button", { name: addName }));
      const input = screen.getByRole("textbox", { name: inputName });
      const form = input.closest("form");
      expect(form).not.toBeNull();
      expect(form?.parentElement?.closest("form")).toBeNull();
      expect(
        screen.getByRole("button", { name: `Add ${type}` })
      ).toHaveAttribute("type", "button");
      const name = type === "room" ? "New room" : `New ${type}`;
      await user.type(input, name);
      const formData = Object.fromEntries(new FormData(form!));
      expect(formData).toEqual({
        intent: "inline-create",
        locationType: type,
        parentId: parentId ?? "",
        name,
        ...(type === "room" || type === "section" ? { color: "#1565C0" } : {}),
      });
      const formAction = new URL(form!.action);
      expect(formAction.pathname).toBe("/locations");
      expect(formAction.searchParams.getAll("index")).toEqual([""]);
      const addButton = within(form!).getByRole("button", { name: "Add" });
      expect(addButton).toHaveAttribute("type", "submit");
      expect(
        within(form!).getByRole("button", { name: "Cancel" })
      ).toHaveAttribute("type", "button");
      if (type === "shelf") await user.click(addButton);
      else await user.keyboard("{Enter}");
      await waitFor(() => expect(createCalls).toHaveLength(1));
      await waitFor(() =>
        expect(getLoaderCalls()).toBeGreaterThan(initialLoaderCalls)
      );
      expect(createCalls[0]).toMatchObject({ type, parentId });
      const group = {
        room: "rooms",
        section: "sections",
        shelf: "shelves",
        container: "containers",
      }[type];
      expect(
        await within(screen.getByRole("region", { name: group })).findByRole(
          "button",
          { name: `New ${type}` }
        )
      ).toBeVisible();
      expect(
        within(screen.getByRole("region", { name: group })).getAllByRole(
          "button",
          { name: `New ${type}` }
        )
      ).toHaveLength(1);
      const selectedParent =
        type === "shelf"
          ? "Section A"
          : type === "container"
          ? "Shelf A1"
          : "IOIO Lab - B477";
      expect(
        screen.getByRole("button", { name: selectedParent })
      ).toHaveAttribute("aria-pressed", "true");
    }
  );

  it("creates a Section in the selected room and remains usable after revalidation", async () => {
    const user = userEvent.setup();
    const { createCalls, getLoaderCalls } = await renderExplorer(
      "/locations?room=room-b477"
    );
    const initialLoaderCalls = getLoaderCalls();
    await user.click(screen.getByRole("button", { name: "Add section" }));
    const input = screen.getByRole("textbox", { name: "Section name" });
    expect(new FormData(input.closest("form")!).get("parentId")).toBe(
      "room-b477"
    );
    expect(new FormData(input.closest("form")!).get("locationType")).toBe(
      "section"
    );
    await user.type(input, "Section D{Enter}");
    await waitFor(() => expect(createCalls).toHaveLength(1));
    await waitFor(() =>
      expect(getLoaderCalls()).toBeGreaterThan(initialLoaderCalls)
    );
    expect(createCalls[0]).toEqual({
      name: "Section D",
      parentId: "room-b477",
      type: "section",
    });
    expect(
      await screen.findByRole("button", { name: "Section D" })
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "IOIO Lab - B477" })
    ).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Add shelf" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Section D" }));
    expect(screen.getByRole("button", { name: "Add shelf" })).toBeEnabled();
  });

  it("supports rapid consecutive section creation in the same room", async () => {
    const user = userEvent.setup();
    const { createCalls, getLoaderCalls } = await renderExplorer(
      "/locations?room=room-b477"
    );
    const initialLoaderCalls = getLoaderCalls();
    await user.click(screen.getByRole("button", { name: "Add section" }));
    let input = screen.getByRole("textbox", { name: "Section name" });
    await user.type(input, "Section D{Enter}");
    await waitFor(() => expect(createCalls).toHaveLength(1));
    await waitFor(() =>
      expect(getLoaderCalls()).toBeGreaterThan(initialLoaderCalls)
    );
    expect(
      await screen.findByRole("button", { name: "Section D" })
    ).toBeVisible();
    input = screen.getByRole("textbox", { name: "Section name" });
    await user.type(input, "Section E{Enter}");
    await waitFor(() => expect(createCalls).toHaveLength(2));
    await waitFor(() =>
      expect(getLoaderCalls()).toBeGreaterThan(initialLoaderCalls + 1)
    );
    expect(
      await screen.findByRole("button", { name: "Section E" })
    ).toBeVisible();
    expect(
      createCalls.map(({ parentId, type }) => ({ parentId, type }))
    ).toEqual([
      { parentId: "room-b477", type: "section" },
      { parentId: "room-b477", type: "section" },
    ]);
  });

  it("waits for loader revalidation before clearing the successful form", async () => {
    const user = userEvent.setup();
    const { getLoaderCalls, finishRevalidation } = await renderExplorer(
      "/locations?room=room-b477",
      { deferRevalidation: true }
    );
    const initialLoaderCalls = getLoaderCalls();
    await user.click(screen.getByRole("button", { name: "Add section" }));
    const input = screen.getByRole("textbox", { name: "Section name" });
    await user.type(input, "Section Delayed");
    await user.keyboard("{Enter}");

    await waitFor(() =>
      expect(getLoaderCalls()).toBeGreaterThan(initialLoaderCalls)
    );
    expect(input).toHaveValue("Section Delayed");
    expect(screen.getByRole("button", { name: "Adding…" })).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: "Section Delayed" })
    ).not.toBeInTheDocument();

    finishRevalidation();
    expect(
      await screen.findByRole("button", { name: "Section Delayed" })
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "IOIO Lab - B477" })
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("keeps a failed name in the form and does not show an uncreated location", async () => {
    const user = userEvent.setup();
    const { createCalls, getLoaderCalls } = await renderExplorer(
      "/locations?room=room-b477",
      { failCreate: true }
    );
    const initialLoaderCalls = getLoaderCalls();
    await user.click(screen.getByRole("button", { name: "Add section" }));
    const input = screen.getByRole("textbox", { name: "Section name" });
    await user.type(input, "Section That Fails");
    await user.keyboard("{Enter}");

    expect(
      await screen.findByText("Location could not be created.")
    ).toBeVisible();
    expect(input).toHaveValue("Section That Fails");
    expect(createCalls).toHaveLength(0);
    expect(getLoaderCalls()).toBe(initialLoaderCalls);
    expect(
      screen.queryByRole("button", { name: "Section That Fails" })
    ).not.toBeInTheDocument();
  });
});
