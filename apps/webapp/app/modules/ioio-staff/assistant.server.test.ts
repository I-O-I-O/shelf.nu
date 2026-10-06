import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  answerInventoryAssistantMock,
  getLabStatusMock,
  requireIoioStaffAccessMock,
} = vi.hoisted(() => ({
  answerInventoryAssistantMock: vi.fn(),
  getLabStatusMock: vi.fn(),
  requireIoioStaffAccessMock: vi.fn(),
}));

vi.mock("~/database/db.server", () => ({
  db: { booking: { count: vi.fn() } },
}));
vi.mock("~/modules/ioio-student/assistant.server", () => ({
  answerInventoryAssistant: answerInventoryAssistantMock,
}));
vi.mock("~/utils/logger", () => ({
  Logger: { info: vi.fn() },
}));
vi.mock("./access.server", () => ({
  requireIoioStaffAccess: requireIoioStaffAccessMock,
}));
vi.mock("./lab-status.server", () => ({
  getLabStatus: getLabStatusMock,
}));

import { answerStaffAssistant } from "./assistant.server";

const context = { getSession: () => ({ userId: "staff-1" }) } as never;
const request = new Request("http://localhost:3000/staff/ask");

describe("Staff Ask IOIO controlled borrowing actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireIoioStaffAccessMock.mockResolvedValue({
      organizationId: "ioio-lab",
      userId: "staff-1",
    });
    answerInventoryAssistantMock.mockResolvedValue({
      mode: "fallback",
      answer: "I prepared a problem report proposal for your review.",
      toolsUsed: [],
      assets: [],
      entityContext: {},
    });
  });

  it("sends a Staff problem report to shared preflight instead of the report-count shortcut", async () => {
    await answerStaffAssistant({
      context,
      request,
      question: "Report the Arduino as broken.",
    });

    expect(getLabStatusMock).not.toHaveBeenCalled();
    expect(answerInventoryAssistantMock).toHaveBeenCalledWith({
      context,
      request,
      question: "Report the Arduino as broken.",
      history: [],
      entityContext: {},
      audience: "staff",
    });
  });
});
