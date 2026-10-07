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
vi.mock("~/components/location/ioio-location-cascade-select", () => ({
  IoioLocationCascadeSelect: () => <div aria-label="Location selector" />,
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

  it("shows the latest IOIO creation sections and controls with empty data", () => {
    render(<IoioAssetCreateForm showAssetModel={false} />);

    expect(screen.getByText("Basic fields")).toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toBeInTheDocument();
    expect(screen.getByText("Tracking method")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /^Quantity Identical units/ })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /^Individual QR tracking/ })
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Quantity")).toBeInTheDocument();
    expect(screen.getByLabelText("Main image upload")).toHaveAttribute(
      "name",
      "mainImage"
    );
    expect(
      screen.getByRole("button", { name: "Category" })
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Location selector")).toBeInTheDocument();
    expect(screen.getByText("Advanced options")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Save" })).toHaveLength(2);
    expect(screen.getAllByRole("link", { name: "Cancel" })).toHaveLength(2);
    expect(screen.getAllByRole("link", { name: "Cancel" })[0]).toHaveAttribute(
      "href",
      "/assets"
    );
    expect(screen.getAllByRole("button", { name: "Add another" })).toHaveLength(
      2
    );
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
