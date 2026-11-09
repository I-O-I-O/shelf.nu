import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HandbookFileList } from "./handbook-file-list";

describe("Handbook file list", () => {
  it("does not render a Files section when an article has no attachments", () => {
    const { container } = render(<HandbookFileList files={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("shows a safe filename, size, and canonical download route", () => {
    render(
      <HandbookFileList
        files={[
          {
            id: "source-1",
            title: "temperature_sensor.ino",
            fileName: "temperature_sensor.ino",
            fileSizeBytes: 12 * 1024,
          },
        ]}
        versionId="version-2"
      />
    );

    expect(screen.getByText("temperature_sensor.ino")).toBeTruthy();
    expect(screen.getByText("12 KB")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Download" })).toHaveAttribute(
      "href",
      "/api/handbook-attachment?sourceId=source-1&versionId=version-2"
    );
  });
});
