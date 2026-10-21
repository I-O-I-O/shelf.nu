import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRoutesStub } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createLoaderArgs } from "@mocks/remix";
import { StudentCheckoutProvider } from "~/components/ioio-student/checkout-context";
import type {
  StudentAsset,
  StudentCategory,
  StudentLocation,
} from "~/modules/ioio-student/service.server";
import IoioHome, { loader as homeLoader } from "~/routes/_layout+/ioio._index";

const mocks = vi.hoisted(() => ({
  db: {
    ioioWriteOperation: { findMany: vi.fn() },
    teamMember: { findMany: vi.fn() },
  },
  requireStudentRead: vi.fn(),
  getStudentAssets: vi.fn(),
  getStudentCategories: vi.fn(),
  getStudentLocations: vi.fn(),
  resolveAssetImagesForPresentation: vi.fn(),
}));

// why: isolate database and student inventory services while verifying that
// Home uses the existing organization-scoped inventory query and filters.
vi.mock("~/database/db.server", () => ({ db: mocks.db }));
vi.mock("~/modules/ioio-student/route.server", () => ({
  requireStudentRead: mocks.requireStudentRead,
}));
vi.mock("~/modules/ioio-student/service.server", () => ({
  getStudentAssets: mocks.getStudentAssets,
  getStudentCategories: mocks.getStudentCategories,
  getStudentLocations: mocks.getStudentLocations,
}));
vi.mock("~/modules/asset/service.server", () => ({
  resolveAssetImagesForPresentation: mocks.resolveAssetImagesForPresentation,
}));
vi.mock("~/modules/ioio-student/load-diagnostics.server", () => ({
  logIoioStudentLoadFailure: vi.fn(),
  logIoioStudentLoadStage: vi.fn(),
  withIoioStudentLoadStage: vi.fn(
    (_stage: string, _diagnostic: boolean, operation: () => unknown) =>
      operation()
  ),
}));
// why: camera APIs are unavailable in happy-dom; the rendered button still
// exposes the audience passed to the existing scanner component.
vi.mock("~/components/ioio/inventory-qr-scanner", () => ({
  InventoryQrScanner: ({
    audience,
    buttonClassName,
    buttonLabel,
    showIcon,
  }: {
    audience: string;
    buttonClassName?: string;
    buttonLabel: string;
    showIcon: boolean;
  }) => (
    <button
      type="button"
      data-testid="inventory-qr-scanner"
      data-audience={audience}
      data-show-icon={showIcon}
      className={buttonClassName}
    >
      {showIcon ? <svg data-testid="inventory-qr-icon" /> : null}
      {buttonLabel}
    </button>
  ),
}));

const category: StudentCategory = {
  id: "category-electronics",
  name: "Electronics",
  color: "#d33",
};

const locations: StudentLocation[] = [
  {
    id: "lab",
    name: "IOIO Lab",
    parentId: null,
    imageUrl: null,
    thumbnailUrl: null,
    assetCount: 1,
    children: [
      {
        id: "electronics-bay",
        name: "Electronics Bay",
        parentId: "lab",
        imageUrl: null,
        thumbnailUrl: null,
        assetCount: 1,
        children: [],
      },
    ],
  },
];

function makeStudentAsset(overrides: Partial<StudentAsset> = {}): StudentAsset {
  return {
    id: "arduino-nano",
    title: "Arduino Nano",
    description: "A small development board",
    mainImage: null,
    mainImageExpiration: null,
    thumbnailImage: null,
    assetModel: null,
    status: "AVAILABLE",
    type: "QUANTITY_TRACKED",
    quantity: 8,
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    assetModelId: null,
    availableQuantity: 5,
    availableToBook: true,
    sequentialId: null,
    category,
    locations: [
      { id: "electronics-bay", name: "Electronics Bay", quantity: 8 },
    ],
    kits: [],
    qrIds: [],
    ...overrides,
  };
}

const homeData = {
  assets: [makeStudentAsset()],
  categories: [category],
  locations,
  query: "",
  categoryId: null,
  itemType: null,
  availability: null,
  locationId: null,
  hasSearchOrFilters: false,
  readyForPickup: [],
  preparing: [],
  returnSubmitted: false,
};

function renderHome() {
  const Stub = createRoutesStub([
    {
      path: "/ioio",
      loader: () => homeData,
      Component: () => (
        <StudentCheckoutProvider>
          <IoioHome />
        </StudentCheckoutProvider>
      ),
      HydrateFallback: () => null,
    },
  ]);
  return render(<Stub initialEntries={["/ioio"]} />);
}

describe("IOIO student Home inventory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireStudentRead.mockResolvedValue({
      userId: "student-1",
      organizationId: "team-1",
      role: "SELF_SERVICE",
    });
    mocks.getStudentAssets.mockResolvedValue([makeStudentAsset()]);
    mocks.getStudentCategories.mockResolvedValue([category]);
    mocks.getStudentLocations.mockResolvedValue(locations);
    mocks.db.ioioWriteOperation.findMany.mockResolvedValue([]);
    mocks.db.teamMember.findMany.mockResolvedValue([]);
    mocks.resolveAssetImagesForPresentation.mockImplementation(
      (assets: unknown[]) => assets
    );
  });

  it("shows inventory cards, search, and the existing student filters on Home", async () => {
    const user = userEvent.setup();
    renderHome();

    expect(
      await screen.findByRole("heading", { name: "Explore inventory" })
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Arduino Nano" })).toHaveAttribute(
      "href",
      "/ioio/browse/arduino-nano"
    );
    expect(screen.getByText("5 ready to borrow")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Add to borrow list" })
    ).toBeInTheDocument();

    const search = screen.getByRole("textbox", { name: "Search inventory" });
    expect(search.closest("form")).toHaveAttribute("action", "/ioio");
    expect(search).toHaveAttribute(
      "placeholder",
      "Search by item name or description"
    );
    await user.click(screen.getByText("Filters"));
    expect(screen.getByLabelText("Category")).toBeInTheDocument();
    expect(screen.getByText("Availability")).toBeInTheDocument();
    expect(screen.getByText("Item type")).toBeInTheDocument();
    expect(screen.getByText("Lab area")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Apply filters" })
    ).toBeInTheDocument();
  });

  it("orders search, scanner, and filters together and removes the Ask IOIO section", async () => {
    renderHome();

    const searchInput = await screen.findByRole("textbox", {
      name: "Search inventory",
    });
    const searchButton = screen.getByRole("button", { name: "Search" });
    const scanner = await screen.findByRole("button", {
      name: "Scan QR",
    });
    const filters = await screen.findByText("Filters");
    expect(scanner).toHaveAttribute("data-audience", "student");
    expect(scanner).toHaveClass(
      "min-h-11",
      "shrink-0",
      "flex-row",
      "whitespace-nowrap",
      "rounded-xl",
      "border-gray-300",
      "font-bold",
      "px-3"
    );
    expect(scanner).toHaveAttribute("data-show-icon", "false");
    expect(screen.queryByTestId("inventory-qr-icon")).toBeNull();
    expect(searchButton).toHaveClass("min-h-11");
    const filtersButton = filters.closest("summary");
    if (!filtersButton) throw new Error("Expected Filters summary trigger");
    expect(filtersButton).toHaveClass("min-h-11");
    expect(
      screen.getByRole("group", { name: "Inventory search and filters" })
    ).toBeInTheDocument();
    const controls = [searchInput, searchButton, scanner, filters];
    for (let index = 0; index < controls.length - 1; index += 1) {
      expect(
        controls[index].compareDocumentPosition(controls[index + 1]) &
          Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy();
    }
    expect(screen.getByTestId("inventory-controls-row")).toHaveClass(
      "flex",
      "flex-wrap",
      "items-center"
    );
    expect(screen.queryByText(/Ask IOIO/i)).toBeNull();
    expect(
      screen.queryByRole("button", { name: /edit|delete|archive/i })
    ).toBeNull();
  });

  it("uses the requested query and validated filters in the student Shelf inventory read", async () => {
    const result = await homeLoader(
      createLoaderArgs({
        context: { getSession: () => ({ userId: "student-1" }) } as never,
        request: new Request(
          "http://localhost/ioio?q=Arduino&category=category-electronics&itemType=quantity&location=electronics-bay&availability=available"
        ),
      })
    );

    if (!("data" in result)) throw new Error("Expected Home loader data");
    expect(mocks.getStudentAssets).toHaveBeenCalledWith({
      organizationId: "team-1",
      query: "Arduino",
      categoryId: "category-electronics",
      locationId: "electronics-bay",
    });
    expect(result.data).toMatchObject({
      query: "Arduino",
      categoryId: "category-electronics",
      itemType: "quantity",
      locationId: "electronics-bay",
      availability: "available",
      assets: [{ id: "arduino-nano" }],
    });
  });
});
