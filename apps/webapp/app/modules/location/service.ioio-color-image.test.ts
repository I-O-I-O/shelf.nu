import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createLocation,
  updateLocation,
  updateLocationImage,
} from "./service.server";

// why: service tests exercise the transaction boundary without changing local data.
const mocks = vi.hoisted(() => {
  const location = {
    findUniqueOrThrow: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  };
  const tx = { location, $queryRaw: vi.fn() };
  return {
    location,
    tx,
    transaction: vi.fn((callback: (client: typeof tx) => unknown) =>
      callback(tx)
    ),
    parseFileFormData: vi.fn(),
    recordEvent: vi.fn(),
  };
});

vi.mock("~/database/db.server", () => ({
  db: { location: mocks.location, $transaction: mocks.transaction },
}));
// why: activity events are a separate persisted side effect, outside the color rule.
vi.mock("~/modules/activity-event/service.server", () => ({
  recordEvent: mocks.recordEvent,
}));
// why: image parser and public storage are external I/O; the test checks the
// optional-file contract passed to them by the location service.
vi.mock("~/utils/storage.server", () => ({
  parseFileFormData: mocks.parseFileFormData,
  getFileUploadPath: vi.fn(() => "locations/test.webp"),
  removePublicFile: vi.fn(),
}));
vi.mock("~/integrations/supabase/client", () => ({
  getSupabaseAdmin: () => ({
    storage: {
      from: () => ({
        getPublicUrl: (path: string) => ({
          data: { publicUrl: `https://example.com/${path}` },
        }),
      }),
    },
  }),
}));

const base = {
  userId: "staff-1",
  organizationId: "org-1",
  description: "",
  address: "",
};

describe("IOIO Location service color and image contracts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tx.$queryRaw.mockResolvedValue([]);
    mocks.location.findMany.mockResolvedValue([]);
    mocks.location.findUniqueOrThrow.mockResolvedValue({
      name: "Section B",
      description: "",
      address: "",
      parentId: "room-1",
      parent: { id: "room-1", name: "Room" },
      color: "#2E7D32",
    });
    mocks.location.update.mockResolvedValue({ id: "section-b" });
    mocks.location.create.mockResolvedValue({ id: "room-new" });
    mocks.parseFileFormData.mockResolvedValue(new FormData());
  });

  it("rejects a duplicate Section color at the write boundary", async () => {
    mocks.location.findMany.mockResolvedValue([
      {
        id: "section-a",
        name: "Section A",
        parentId: "room-1",
        color: "#6A1B9A",
      },
    ]);
    await expect(
      updateLocation({
        ...base,
        id: "section-b",
        color: "#6A1B9A",
        ioioColorType: "section",
      })
    ).rejects.toThrow("This color is already used by Section A in this room.");
    expect(mocks.location.update).not.toHaveBeenCalled();
    expect(mocks.tx.$queryRaw).toHaveBeenCalledOnce();
  });

  it("rejects a color already printed by a legacy Section with no stored color", async () => {
    mocks.location.findMany.mockResolvedValue([
      { id: "room-1", name: "Room", parentId: null, color: "#1565C0" },
      { id: "legacy", name: "Seciton A", parentId: "room-1", color: null },
    ]);
    await expect(
      updateLocation({
        ...base,
        id: "section-b",
        color: "#1565C0",
        ioioColorType: "section",
      })
    ).rejects.toThrow("This color is already used by Seciton A in this room.");
    expect(mocks.location.update).not.toHaveBeenCalled();
  });

  it("allows a Section to keep its own color", async () => {
    mocks.location.findMany.mockResolvedValue([
      {
        id: "section-b",
        name: "Section B",
        parentId: "room-1",
        color: "#2E7D32",
      },
    ]);
    await updateLocation({
      ...base,
      id: "section-b",
      color: "#2E7D32",
      ioioColorType: "section",
    });
    expect(mocks.location.update).toHaveBeenCalledOnce();
  });

  it("rejects a duplicate Room color at the write boundary", async () => {
    mocks.location.findMany.mockResolvedValue([
      { id: "room-a", name: "Room A", parentId: null, color: "#1565C0" },
    ]);
    await expect(
      createLocation({
        ...base,
        name: "Room B",
        parentId: null,
        color: "#1565C0",
        ioioColorType: "room",
      })
    ).rejects.toThrow("This color is already used by Room A.");
    expect(mocks.location.create).not.toHaveBeenCalled();
  });

  it("saves a Room color change without adding an image", async () => {
    mocks.location.findUniqueOrThrow.mockResolvedValue({
      name: "Room B",
      description: "",
      address: "",
      parentId: null,
      parent: null,
      color: "#1565C0",
    });
    mocks.location.findMany.mockResolvedValue([
      { id: "room-b", name: "Room B", parentId: null, color: "#1565C0" },
      { id: "room-a", name: "Room A", parentId: null, color: "#2E7D32" },
    ]);
    await updateLocation({
      ...base,
      id: "room-b",
      color: "#6A1B9A",
      ioioColorType: "room",
    });
    await updateLocationImage({
      organizationId: "org-1",
      locationId: "room-b",
      request: new Request("https://example.com/locations/room-b/edit"),
    });
    expect(mocks.location.update).toHaveBeenCalledOnce();
    expect(mocks.location.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ color: "#6A1B9A" }),
      })
    );
  });

  it("does not let a Room color change create duplicate effective Section colors", async () => {
    mocks.location.findUniqueOrThrow.mockResolvedValue({
      name: "Room B",
      description: "",
      address: "",
      parentId: null,
      parent: null,
      color: "#1565C0",
    });
    mocks.location.findMany
      .mockResolvedValueOnce([
        { id: "room-b", name: "Room B", parentId: null, color: "#1565C0" },
      ])
      .mockResolvedValueOnce([
        {
          id: "legacy",
          name: "Legacy Section",
          parentId: "room-b",
          color: null,
        },
        {
          id: "section-a",
          name: "Section A",
          parentId: "room-b",
          color: "#2E7D32",
        },
      ]);
    await expect(
      updateLocation({
        ...base,
        id: "room-b",
        color: "#2E7D32",
        ioioColorType: "room",
      })
    ).rejects.toThrow(/conflict with Legacy Section/u);
    expect(mocks.location.update).not.toHaveBeenCalled();
  });

  it("treats an unselected image file as absent and preserves an existing image", async () => {
    await updateLocationImage({
      organizationId: "org-1",
      locationId: "section-b",
      request: new Request("https://example.com/locations/section-b/edit"),
      prevImageUrl: "https://example.com/existing.webp",
    });
    expect(mocks.parseFileFormData).toHaveBeenCalledWith(
      expect.objectContaining({ allowEmptyFile: true })
    );
    expect(mocks.location.update).not.toHaveBeenCalled();
  });

  it("still saves a provided optional image", async () => {
    const uploaded = new FormData();
    uploaded.set("image", "locations/new.webp");
    mocks.parseFileFormData.mockResolvedValue(uploaded);
    await updateLocationImage({
      organizationId: "org-1",
      locationId: "section-b",
      request: new Request("https://example.com/locations/section-b/edit"),
    });
    expect(mocks.location.update).toHaveBeenCalledWith({
      where: { id: "section-b", organizationId: "org-1" },
      data: {
        imageUrl: "https://example.com/locations/new.webp",
        thumbnailUrl: undefined,
      },
    });
  });
});
