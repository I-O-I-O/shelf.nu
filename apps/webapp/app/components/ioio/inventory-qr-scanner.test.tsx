import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { expect, it, vi } from "vitest";
import { ImportButton } from "~/components/assets/import-button";
import { InventoryQrScanner } from "./inventory-qr-scanner";

// why: camera hardware is unavailable in happy-dom; opening the existing
// scanner dialog is enough to verify the trigger still invokes it.
vi.mock("~/components/scanner/code-scanner", () => ({
  CodeScanner: () => <div>Camera scanner</div>,
}));

it("uses Import's neutral button style for the staff Scan QR trigger", () => {
  render(
    <MemoryRouter>
      <ImportButton canImportAssets to="/staff/import" />
      <InventoryQrScanner
        audience="staff"
        buttonLabel="Scan QR"
        showIcon={false}
      />
    </MemoryRouter>
  );

  const importButton = screen.getByRole("link", { name: "Import" });
  const scanButton = screen.getByRole("button", { name: "Scan QR" });
  expect(scanButton.className).toBe(importButton.className);
  expect(scanButton.querySelector("svg")).toBeNull();
  expect(screen.queryByText("Scan QR code")).toBeNull();

  fireEvent.click(scanButton);
  expect(screen.getByText("Camera scanner")).toBeInTheDocument();
});
