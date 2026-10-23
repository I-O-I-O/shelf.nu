import type { ReactNode } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  IoioAssetCreateForm,
  NewAssetFormSchema,
} from "./ioio-asset-create-form";

const routeData = {
  customFields: [],
  locations: [],
  assetModels: [],
};
const navigate = vi.fn();

// why: the component consumes route loader/action/navigation state; these
// hooks are supplied directly so the test can exercise the form in isolation.
vi.mock("react-router", () => ({
  useActionData: () => undefined,
  useFetcher: () => ({ state: "idle", submit: vi.fn(), data: undefined }),
  useLoaderData: () => routeData,
  useLocation: () => ({ pathname: "/assets/new", search: "" }),
  useNavigate: () => navigate,
  useNavigation: () => ({ state: "idle" }),
  useRevalidator: () => ({ revalidate: vi.fn() }),
}));

// why: these components use router primitives or remote select endpoints;
// the form test checks the IOIO field structure and user-visible options.
vi.mock("~/components/custom-form", () => ({
  Form: ({ children }: { children: ReactNode }) => <form>{children}</form>,
}));
vi.mock("~/components/dynamic-select/dynamic-select", () => ({
  default: ({ label }: { label: string }) => (
    <button type="button">{label}</button>
  ),
}));
vi.mock("~/components/ioio/ioio-image-picker", () => ({
  IoioImagePicker: ({ name }: { name: string }) => (
    <input aria-label="Main image upload" name={name} type="file" />
  ),
}));
vi.mock("../location/location-select", () => ({
  LocationSelect: ({
    locationId,
    forceServerSearch,
    hideCurrentLocationInput,
    disabled,
  }: {
    locationId?: string | null;
    forceServerSearch?: boolean;
    hideCurrentLocationInput?: boolean;
    disabled?: boolean;
  }) => (
    <div
      aria-label="Shelf location selector"
      data-location-id={locationId ?? ""}
      data-force-server-search={String(forceServerSearch)}
      data-hide-current-location-input={String(hideCurrentLocationInput)}
      data-disabled={String(disabled)}
    />
  ),
}));
vi.mock("~/components/forms/referer-redirect-input", () => ({
  RefererRedirectInput: () => null,
}));
vi.mock("~/components/shared/button", () => ({
  Button: ({
    children,
    to,
    type,
    ...props
  }: {
    children: ReactNode;
    to?: string;
    type?: "button" | "submit";
    [key: string]: unknown;
  }) =>
    to ? (
      <a href={to} {...props}>
        {children}
      </a>
    ) : (
      <button type={type ?? "button"} {...props}>
        {children}
      </button>
    ),
}));

describe("IOIO asset creation form", () => {
  beforeEach(() => {
    navigate.mockClear();
  });

  it("starts new assets with the existing quantity and preparation defaults", () => {
    render(<IoioAssetCreateForm showAssetModel={false} />);

    expect(
      screen.getByRole("button", { name: /^Quantity Identical units/ })
    ).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByText("Advanced options"));
    expect(screen.getByLabelText("Requires preparation")).not.toBeChecked();
    expect(screen.getByLabelText("Assigned storage location")).toBeChecked();
  });

  it("presets preparation and return handling only when tracking changes to individual", () => {
    render(<IoioAssetCreateForm showAssetModel={false} />);
    const individualTracking = screen.getByRole("button", {
      name: /^Individual QR tracking/,
    });
    fireEvent.click(individualTracking);
    fireEvent.click(screen.getByText("Advanced options"));

    const preparation = screen.getByLabelText("Requires preparation");
    const staffReturn = screen.getByLabelText("Return section for staff check");
    const storageReturn = screen.getByLabelText("Assigned storage location");
    expect(preparation).toBeChecked();
    expect(staffReturn).toBeChecked();
    expect(storageReturn).not.toBeChecked();

    fireEvent.click(preparation);
    expect(preparation).not.toBeChecked();
    fireEvent.click(storageReturn);
    expect(staffReturn).not.toBeChecked();
    expect(storageReturn).toBeChecked();

    // Re-selecting an already active value and other form changes preserve overrides.
    fireEvent.click(individualTracking);
    expect(preparation).not.toBeChecked();
    expect(storageReturn).toBeChecked();
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Edited item title" },
    });
    expect(preparation).not.toBeChecked();
    expect(storageReturn).toBeChecked();
  });

  it("keeps preparation and return handling when individual tracking is turned off", () => {
    render(
      <IoioAssetCreateForm
        showAssetModel={false}
        type="INDIVIDUAL"
        requiresStaffPreparation
        returnHandling="RETURN_TO_RETURN_ZONE"
      />
    );
    fireEvent.click(screen.getByText("Advanced options"));

    const preparation = screen.getByLabelText("Requires preparation");
    const staffReturn = screen.getByLabelText("Return section for staff check");
    expect(preparation).toBeChecked();
    expect(staffReturn).toBeChecked();
    fireEvent.click(
      screen.getByRole("button", { name: /^Quantity Identical units/ })
    );
    expect(preparation).toBeChecked();
    expect(staffReturn).toBeChecked();
  });

  it.each([
    ["INDIVIDUAL", false, "RETURN_TO_STORAGE"],
    ["INDIVIDUAL", true, "RETURN_TO_RETURN_ZONE"],
    ["QUANTITY_TRACKED", true, "RETURN_TO_STORAGE"],
  ] as const)(
    "preserves saved edit defaults for tracking %s, preparation %s, and destination %s",
    (type, requiresStaffPreparation, returnHandling) => {
      render(
        <IoioAssetCreateForm
          id="asset-1"
          showAssetModel={false}
          type={type}
          requiresStaffPreparation={requiresStaffPreparation}
          returnHandling={returnHandling}
        />
      );
      fireEvent.click(screen.getByText("Advanced options"));

      expect(screen.getByLabelText("Requires preparation")).toHaveProperty(
        "checked",
        requiresStaffPreparation
      );
      expect(
        screen.getByLabelText("Return section for staff check")
      ).toHaveProperty("checked", returnHandling === "RETURN_TO_RETURN_ZONE");
      expect(screen.getByLabelText("Assigned storage location")).toHaveProperty(
        "checked",
        returnHandling === "RETURN_TO_STORAGE"
      );
    }
  );

  it("presets preparation when editing and changing quantity tracking to individual", () => {
    render(
      <IoioAssetCreateForm
        id="asset-1"
        showAssetModel={false}
        type="QUANTITY_TRACKED"
        requiresStaffPreparation={false}
      />
    );
    fireEvent.click(screen.getByText("Advanced options"));
    const preparation = screen.getByLabelText("Requires preparation");
    expect(preparation).not.toBeChecked();

    fireEvent.click(
      screen.getByRole("button", { name: /^Individual QR tracking/ })
    );
    expect(preparation).toBeChecked();
  });

  it("submits individual tracking with both manual overrides and leaves assigned location unchanged", () => {
    render(
      <IoioAssetCreateForm
        showAssetModel={false}
        locationId="assigned-container-1"
      />
    );
    fireEvent.click(
      screen.getByRole("button", { name: /^Individual QR tracking/ })
    );
    fireEvent.click(screen.getByText("Advanced options"));
    fireEvent.click(screen.getByLabelText("Requires preparation"));
    fireEvent.click(screen.getByLabelText("Assigned storage location"));

    const form = (screen.getByLabelText("Name") as HTMLInputElement).form;
    expect(form).toBeInTheDocument();
    const formData = new FormData(form!);
    expect(formData.get("type")).toBe("INDIVIDUAL");
    expect(formData.get("requiresStaffPreparation")).toBeNull();
    expect(formData.get("returnHandling")).toBe("RETURN_TO_STORAGE");
    expect(screen.getByLabelText("Shelf location selector")).toHaveAttribute(
      "data-location-id",
      "assigned-container-1"
    );
    const parsed = NewAssetFormSchema.parse({
      title: "Test asset",
      description: "",
      category: "uncategorized",
      type: formData.get("type"),
      returnHandling: formData.get("returnHandling"),
      requiresStaffPreparation:
        formData.get("requiresStaffPreparation") ?? undefined,
    });
    expect(parsed.requiresStaffPreparation).toBe(false);
    expect(parsed.returnHandling).toBe("RETURN_TO_STORAGE");
  });

  it("shows the latest IOIO creation sections and controls with empty data", () => {
    render(<IoioAssetCreateForm assetQueueMode showAssetModel={false} />);

    expect(screen.queryByText("Basic fields")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Basic information about your asset.")
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toBeInTheDocument();
    expect(screen.getByText("Tracking method")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /^Quantity Identical units/ })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: /^Individual QR tracking \(kits\)/,
      })
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Quantity")).toBeInTheDocument();
    expect(screen.getByText("Main image (optional)")).toBeInTheDocument();
    expect(screen.getByLabelText("Main image upload")).toHaveAttribute(
      "name",
      "mainImage"
    );
    expect(screen.getByLabelText("Main image upload")).not.toBeRequired();
    expect(
      screen.getByRole("button", { name: "Category" })
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Shelf location selector")).toHaveAttribute(
      "data-force-server-search",
      "true"
    );
    expect(screen.getByLabelText("Shelf location selector")).toHaveAttribute(
      "data-hide-current-location-input",
      "true"
    );
    expect(screen.getByText("Advanced options")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Save" })).toHaveLength(1);
    expect(screen.getAllByRole("link", { name: "Cancel" })).toHaveLength(1);
    expect(screen.getByRole("link", { name: "Cancel" })).toHaveAttribute(
      "href",
      "/assets"
    );
    expect(screen.getAllByRole("button", { name: "Add another" })).toHaveLength(
      1
    );
  });

  it("uses Shelf's searchable selector with the current location when editing", () => {
    render(
      <IoioAssetCreateForm
        id="asset-1"
        title="Makey Kit"
        locationId="container-1"
        showAssetModel={false}
      />
    );

    expect(screen.getByLabelText("Shelf location selector")).toHaveAttribute(
      "data-location-id",
      "container-1"
    );
    expect(screen.getByLabelText("Shelf location selector")).toHaveAttribute(
      "data-force-server-search",
      "true"
    );
    expect(screen.getByLabelText("Shelf location selector")).toHaveAttribute(
      "data-hide-current-location-input",
      "false"
    );
    expect(
      screen.getByText(
        "Search and select a room, section, shelf, or container."
      )
    ).toBeInTheDocument();
  });

  it("keeps expanded advanced options inside the fluid queue form card", () => {
    render(<IoioAssetCreateForm assetQueueMode showAssetModel={false} />);

    const nameInput = screen.getByLabelText("Name");
    const formCard = nameInput.closest(".card");
    const advancedOptions = screen.getByText("Advanced options");

    expect(formCard).toHaveClass("w-full", "min-w-0");
    expect(formCard).not.toHaveClass("lg:w-min");

    fireEvent.click(advancedOptions);

    const details = advancedOptions.closest("details");
    const borrowingPeriod = screen.getByLabelText("Maximum borrowing period");
    const saveButton = screen.getAllByRole("button", { name: "Save" })[0];

    expect(details).toHaveProperty("open", true);
    expect(formCard).toContainElement(details);
    expect(formCard).toContainElement(borrowingPeriod);
    expect(formCard).toContainElement(saveButton);
  });

  it("renders one canonical title control inside the submitted form", () => {
    const { rerender } = render(
      <IoioAssetCreateForm assetQueueMode showAssetModel={false} />
    );

    const titleInput = screen.getByLabelText("Name") as HTMLInputElement;
    const form = titleInput.form;

    expect(titleInput).toHaveAttribute("name", "title");
    expect(titleInput).not.toBeDisabled();
    expect(form).toBeInTheDocument();
    expect(form?.querySelectorAll('[name="title"]')).toHaveLength(1);

    fireEvent.change(titleInput, { target: { value: "Arduino Uno" } });
    const formData = new FormData(form!);
    expect(formData.get("title")).toBe("Arduino Uno");
    expect(formData.getAll("title")).toEqual(["Arduino Uno"]);

    rerender(
      <IoioAssetCreateForm
        assetQueueMode
        assetQueueSaving
        showAssetModel={false}
      />
    );
    expect(titleInput).toHaveValue("Arduino Uno");
    expect(titleInput).toBeDisabled();
    expect(new FormData(form!).get("title")).toBeNull();
    expect(formData.get("title")).toBe("Arduino Uno");
  });

  it("uses the same IOIO fields when editing a general item", () => {
    render(
      <IoioAssetCreateForm
        id="asset-1"
        title="Makey Kit"
        description="Shared product description"
        productGroup={{
          name: "Makey Kit",
          locationIsMixed: false,
          hasImage: false,
        }}
        showAssetModel={false}
      />
    );

    expect(screen.getByLabelText("Name")).toHaveValue("Makey Kit");
    expect(screen.getByLabelText("Description")).toHaveValue(
      "Shared product description"
    );
    expect(screen.getByText("Basic fields")).toBeInTheDocument();
    expect(screen.queryByText("Alternative Barcodes")).not.toBeInTheDocument();
    expect(screen.queryByText("Custom Fields")).not.toBeInTheDocument();
  });

  it("reopens an individual product with its persisted Return section choice", () => {
    render(
      <IoioAssetCreateForm
        id="unit-2"
        title="Makey Kit #002"
        type="INDIVIDUAL"
        returnHandling="RETURN_TO_RETURN_ZONE"
        showAssetModel={false}
      />
    );

    expect(screen.getByText("Return section")).toBeInTheDocument();
    expect(
      screen.getByLabelText("Return section for staff check")
    ).toBeChecked();
  });

  it("switches from quantity to individual physical-unit quantity", () => {
    render(<IoioAssetCreateForm showAssetModel={false} />);

    fireEvent.click(
      screen.getByRole("button", { name: /^Individual QR tracking/ })
    );

    expect(
      screen.getByLabelText("Number of physical units")
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Quantity")).not.toBeInTheDocument();
  });

  it("returns a direct edit to Inventory when Cancel has no referer", () => {
    render(
      <IoioAssetCreateForm
        id="asset-1"
        title="Makey Kit"
        showAssetModel={false}
      />
    );

    expect(screen.getAllByRole("link", { name: "Cancel" })[0]).toHaveAttribute(
      "href",
      "/assets"
    );
  });

  it("preserves the filtered Inventory context for Cancel", () => {
    render(
      <IoioAssetCreateForm
        id="asset-1"
        title="Makey Kit"
        referer="/assets?search=Makey"
        showAssetModel={false}
      />
    );

    expect(screen.getAllByRole("link", { name: "Cancel" })[0]).toHaveAttribute(
      "href",
      "/assets?search=Makey"
    );
  });

  it("validates a name and preserves the selected tracking and quantity values", () => {
    const result = NewAssetFormSchema.safeParse({
      title: "  Laptop  ",
      description: "",
      category: "uncategorized",
      type: "INDIVIDUAL",
      quantity: "3",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.title).toBe("Laptop");
      expect(result.data.type).toBe("INDIVIDUAL");
      expect(result.data.quantity).toBe(3);
    }
    expect(
      NewAssetFormSchema.safeParse({
        title: "",
        description: "",
        category: "uncategorized",
      }).success
    ).toBe(false);
  });
});
