import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { submitObservationMock } = vi.hoisted(() => ({
  submitObservationMock: vi.fn(),
}));

vi.mock("~/modules/ioio-handbook/service.server", () => ({
  submitHandbookObservation: submitObservationMock,
}));

import { submitAskIoioKnowledge } from "./request-routing.server";

describe("Ask IOIO Handbook contribution persistence", () => {
  beforeEach(() => vi.clearAllMocks());

  it("claims a contribution was saved only after the observation service succeeds", async () => {
    submitObservationMock.mockResolvedValue({
      id: "observation-1",
      duplicate: false,
      related: [],
    });
    const result = await submitAskIoioKnowledge({
      organizationId: "org-1",
      userId: "student-1",
      question:
        "The Grove Kit contains a carrier board and a vibration motor. Log it in the Handbook.",
      history: [],
      intent: "knowledge_contribution",
    });

    expect(submitObservationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org-1",
        userId: "student-1",
        title: "The Grove Kit knowledge",
        content:
          "The Grove Kit contains a carrier board and a vibration motor.",
      })
    );
    expect(result).toMatchObject({ outcome: "pending_observation" });
    expect(result.answer).toContain("Saved as a pending");
    expect(result.answer).toContain("not changed the published Handbook");
  });

  it("reports an existing duplicate without claiming a new save", async () => {
    submitObservationMock.mockResolvedValue({
      duplicate: true,
      duplicateKind: "observation",
      duplicateTitle: "Grove Kit knowledge",
      related: [{ kind: "observation" }],
    });
    const result = await submitAskIoioKnowledge({
      organizationId: "org-1",
      userId: "student-1",
      question:
        "The Grove Kit contains a carrier board and a vibration motor. Log it in the Handbook.",
      history: [],
      intent: "knowledge_contribution",
    });

    expect(result.outcome).toBe("duplicate");
    expect(result.answer).toContain("did not create a duplicate");
    expect(result.answer).not.toContain("Saved");
  });

  it("does not claim persistence when the Handbook table is unavailable", async () => {
    submitObservationMock.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Handbook table missing", {
        code: "P2021",
        clientVersion: "test",
      })
    );
    const result = await submitAskIoioKnowledge({
      organizationId: "org-1",
      userId: "student-1",
      question:
        "The Grove Kit contains a carrier board and a vibration motor. Log it in the Handbook.",
      history: [],
      intent: "knowledge_contribution",
    });

    expect(result.outcome).toBe("storage_unavailable");
    expect(result.answer).toContain("Nothing was saved or published");
    expect(result.answer).not.toContain("Saved");
  });
});
