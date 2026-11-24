// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  record: null as null | Record<string, unknown>,
  findUnique: vi.fn(),
  upsert: vi.fn(),
  recordEvent: vi.fn(),
}));

vi.mock("~/database/db.server", () => ({
  db: {
    ioioAiGuidelines: {
      findUnique: mocks.findUnique,
    },
    $transaction: (callback: (tx: unknown) => Promise<unknown>) =>
      callback({ ioioAiGuidelines: { upsert: mocks.upsert } }),
  },
}));
vi.mock("~/modules/activity-event/service.server", () => ({
  recordEvent: mocks.recordEvent,
}));

import { EMPTY_IOIO_AI_GUIDELINES } from "./guidelines.shared";
import {
  getIoioAiGuidelines,
  getIoioAiGuidelinesForPrompt,
  saveIoioAiGuidelines,
} from "./service.server";

describe("organization AI guidelines persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.record = null;
    mocks.findUnique.mockImplementation(() => Promise.resolve(mocks.record));
    mocks.upsert.mockImplementation(({ create, update }) => {
      const source = mocks.record ? update : create;
      mocks.record = {
        sections: source.sections,
        updatedAt: new Date("2026-09-30T12:00:00.000Z"),
        updatedBy: {
          displayName: "IOIO Staff",
          firstName: null,
          lastName: null,
        },
      };
      return Promise.resolve(mocks.record);
    });
  });

  it("returns empty section defaults before Staff has customized them", async () => {
    const result = await getIoioAiGuidelines("org-1");
    expect(result.sections).toEqual(EMPTY_IOIO_AI_GUIDELINES);
    expect(result.updatedAt).toBeNull();
    expect(result.updatedBy).toBeNull();
  });

  it("saves organization-scoped content with updater metadata and an audit event", async () => {
    const sections = {
      ...EMPTY_IOIO_AI_GUIDELINES,
      generalBehaviour: "Keep answers clear.",
    };
    await saveIoioAiGuidelines({
      organizationId: "org-1",
      userId: "staff-1",
      sections,
    });

    expect(mocks.upsert).toHaveBeenCalledWith({
      where: { organizationId: "org-1" },
      create: {
        organizationId: "org-1",
        sections,
        updatedByUserId: "staff-1",
      },
      update: { sections, updatedByUserId: "staff-1" },
    });
    expect(mocks.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "IOIO_AI_GUIDELINES_UPDATED",
        organizationId: "org-1",
        actorUserId: "staff-1",
        entityType: "ORGANIZATION",
        entityId: "org-1",
      }),
      expect.any(Object)
    );
  });

  it("returns saved values and updater after a subsequent read", async () => {
    const sections = {
      ...EMPTY_IOIO_AI_GUIDELINES,
      inventory: "Use a short summary.",
    };
    mocks.record = {
      sections,
      updatedAt: new Date("2026-09-30T12:00:00.000Z"),
      updatedBy: {
        displayName: "IOIO Staff",
        firstName: null,
        lastName: null,
      },
    };

    const result = await getIoioAiGuidelines("org-1");
    expect(result.sections).toEqual(sections);
    expect(result.updatedAt).toBe("2026-09-30T12:00:00.000Z");
    expect(result.updatedBy).toBe("IOIO Staff");
    expect(await getIoioAiGuidelinesForPrompt("org-1")).toEqual(sections);
  });
});
