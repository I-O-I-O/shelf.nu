import type { ComponentProps, ReactElement } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// why: the quick-action permission branch needs an authorized Staff role.
vi.mock("~/hooks/user-user-role-helper", () => ({
  useUserRoleHelper: () => ({ roles: ["ADMIN"] }),
}));

// why: this test exercises the authorized Staff presentation branch only.
vi.mock("~/utils/permissions/permission.validator.client", () => ({
  userHasPermission: () => true,
}));

// why: the real Button uses React Router navigation, which this presentation
// test does not need to exercise.
vi.mock("~/components/shared/button", () => ({
  Button: ({
    children,
    to: _to,
    tooltip: _tooltip,
    size: _size,
    variant: _variant,
    width: _width,
    ...props
  }: ComponentProps<"button"> & {
    to?: string;
    tooltip?: string;
    size?: string;
    variant?: string;
    width?: string;
  }) => <button {...props}>{children}</button>,
}));

// why: QR preview rendering is unrelated to the lifecycle action under test.
vi.mock("~/components/code-preview/code-preview-dialog", () => ({
  CodePreviewDialog: () => null,
}));

// why: this test checks which existing Shelf lifecycle behavior the Staff
// quick action selects; the DeleteAsset component owns the confirmation UI.
vi.mock("../delete-asset", () => ({
  DeleteAsset: ({
    behavior,
    trigger,
  }: {
    behavior: string;
    trigger: ReactElement;
  }) => <div data-lifecycle-behavior={behavior}>{trigger}</div>,
}));

import AssetQuickActions from "./asset-quick-actions";

describe("Staff asset quick actions", () => {
  it("labels the reversible Trash lifecycle as Delete", () => {
    render(
      <AssetQuickActions
        asset={{
          id: "asset-1",
          title: "IOIO image upload",
          mainImage: null,
          qrId: "qr-1",
        }}
      />
    );

    expect(
      screen.getByRole("button", { name: "Delete asset" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Delete asset" }).parentElement
    ).toHaveAttribute("data-lifecycle-behavior", "trash");
    expect(
      screen.queryByRole("button", { name: "Move asset to trash" })
    ).toBeNull();
  });
});
