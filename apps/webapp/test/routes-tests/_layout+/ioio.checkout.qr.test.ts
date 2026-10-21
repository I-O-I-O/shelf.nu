import { createElement } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireIoioBorrowerAccess: vi.fn(),
  borrowItem: vi.fn(),
  requestPreparation: vi.fn(),
  assetFindFirst: vi.fn(),
  qrFindFirst: vi.fn(),
  resolvePhysicalUnitNumber: vi.fn(),
}));

// why: this route test exercises its actual QR resolution action while keeping
// persistence inside the isolated service mocks rather than a live database.
vi.mock("~/database/db.server", () => ({
  db: {
    asset: { findFirst: mocks.assetFindFirst },
    qr: { findFirst: mocks.qrFindFirst },
  },
}));
vi.mock("~/modules/ioio-student/route.server", () => ({
  requireIoioBorrowerAccess: mocks.requireIoioBorrowerAccess,
}));
vi.mock("~/modules/ioio-student/borrow-item.server", () => ({
  borrowItem: mocks.borrowItem,
  acknowledgeBorrowItemStaffReservation: vi.fn(),
  cancelBorrowItem: vi.fn(),
  getBorrowItemAvailability: vi.fn(),
  prepareBorrowItem: vi.fn(),
  requestPreparationForItem: mocks.requestPreparation,
  resolvePhysicalUnitNumber: mocks.resolvePhysicalUnitNumber,
}));
vi.mock("lottie-react", () => ({ default: () => null }));

import { StudentCheckoutProvider } from "~/components/ioio-student/checkout-context";
import type { StudentCheckoutItem } from "~/components/ioio-student/checkout-context";
import IoioCheckout, {
  action,
  loader as checkoutLoader,
} from "~/routes/_layout+/ioio.checkout";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireIoioBorrowerAccess.mockResolvedValue({
    userId: "student-1",
    organizationId: "ioio-dev",
    role: "SELF_SERVICE",
  });
  mocks.assetFindFirst.mockImplementation(({ where }) =>
    Promise.resolve(
      where.id === "logical-makey"
        ? {
            title: "Makey Kit",
            type: "INDIVIDUAL",
            assetModelId: "makey-model",
            assetKits: [],
          }
        : {
            id: "unit-003",
            title: "Makey Kit #003",
            assetModelId: "makey-model",
            assetKits: [],
          }
    )
  );
  mocks.qrFindFirst.mockResolvedValue({ assetId: "unit-003" });
  mocks.resolvePhysicalUnitNumber.mockResolvedValue({
    physicalAssetId: "unit-003",
    title: "Makey Kit #003",
    unitNumber: "003",
    qrId: "vdqo0i7hk9",
  });
  mocks.borrowItem.mockResolvedValue({
    status: "submitted",
    dueDate: "2026-11-01T00:00:00.000Z",
  });
  mocks.requestPreparation.mockResolvedValue({
    status: "requested",
    requestId: "preparation-request-1",
  });
});

function renderBorrowingList(
  requiresStaffPreparation: boolean,
  options: {
    itemType?: StudentCheckoutItem["type"];
    loadProposal?: boolean;
    reservationWarning?: boolean;
  } = {}
) {
  const itemType = options.itemType ?? "INDIVIDUAL";
  const itemId = itemType === "QUANTITY_TRACKED" ? "motor" : "makey-kit";
  const itemTitle = itemType === "QUANTITY_TRACKED" ? "Motor" : "Makey Kit";
  const item: StudentCheckoutItem = {
    id: itemId,
    preparationSubmissionToken: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    title: itemTitle,
    type: itemType,
    isKit: itemType === "INDIVIDUAL",
    mainImage: null,
    thumbnailImage: null,
    quantity: 5,
    borrowQuantity: 1,
    assetModel: null,
    availableQuantity: 5,
    maxBorrowDays: 45,
    requiresBorrowApproval: false,
    requiresStaffPreparation,
    location: "Container A1-1",
    candidateAssetIds: ["makey-kit-unit-001"],
  };
  window.sessionStorage.clear();
  window.sessionStorage.setItem(
    "ioio-student-checkout",
    JSON.stringify([item])
  );

  const routeAction = async ({ request }: { request: Request }) => {
    if (!options.loadProposal) return null;
    const formData = await request.formData();
    const intent = formData.get("intent");
    if (intent === "availability") {
      return {
        ok: true,
        intent: "availability",
        availableQuantity: 5,
        totalQuantity: 5,
        staffReservedCount: options.reservationWarning ? 1 : 0,
        availableWithoutStaffReservations: 5,
        staffReservationFrom: null,
        staffReservationTo: null,
      };
    }
    if (intent === "prepare") {
      return {
        ok: true,
        intent: "prepared",
        proposal: {
          confirmationToken: "motor-proposal-token",
          operationId: "motor-operation",
          asset: {
            id: itemId,
            title: itemTitle,
            type: itemType,
            location: "Container A1-1",
          },
          kit: null,
          quantity: 1,
          selectedPhysicalUnitIds: [],
          availableQuantity: 5,
          from: "2026-10-20T00:00:00.000Z",
          to: "2026-11-20T00:00:00.000Z",
          restriction: null,
          requiresApproval: false,
          requiresStaffPreparation: false,
          staffReservationWarning: options.reservationWarning
            ? {
                reservedCount: 1,
                totalCount: 5,
                from: "2026-10-20T00:00:00.000Z",
                to: "2026-11-20T00:00:00.000Z",
              }
            : null,
        },
      };
    }
    return null;
  };

  const Stub = createRoutesStub([
    {
      path: "/ioio/checkout",
      loader: () => null,
      action: routeAction,
      Component: () =>
        createElement(
          StudentCheckoutProvider,
          null,
          createElement(IoioCheckout)
        ),
    },
  ]);

  return render(createElement(Stub, { initialEntries: ["/ioio/checkout"] }));
}

function renderMixedBorrowingList() {
  const items: StudentCheckoutItem[] = [
    {
      id: "makey-kit",
      preparationSubmissionToken: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      title: "Makey Kit",
      type: "INDIVIDUAL",
      isKit: true,
      mainImage: null,
      thumbnailImage: null,
      quantity: 5,
      borrowQuantity: 1,
      assetModel: null,
      availableQuantity: 5,
      maxBorrowDays: 45,
      requiresBorrowApproval: false,
      requiresStaffPreparation: true,
      location: "Container A1-1",
      candidateAssetIds: ["makey-unit-003", "makey-unit-004"],
    },
    {
      id: "motor",
      preparationSubmissionToken: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      title: "Motor",
      type: "QUANTITY_TRACKED",
      isKit: false,
      mainImage: null,
      thumbnailImage: null,
      quantity: 5,
      borrowQuantity: 1,
      assetModel: null,
      availableQuantity: 5,
      maxBorrowDays: 45,
      requiresBorrowApproval: false,
      requiresStaffPreparation: false,
      location: "Container B1-1",
      candidateAssetIds: ["motor"],
    },
  ];
  const prepareCounts = new Map<string, number>();
  window.sessionStorage.clear();
  window.sessionStorage.setItem("ioio-student-checkout", JSON.stringify(items));

  const Stub = createRoutesStub([
    {
      path: "/ioio/checkout",
      loader: () => null,
      action: async ({ request }) => {
        const formData = await request.formData();
        const intent = formData.get("intent");
        if (intent === "availability") {
          return {
            ok: true,
            intent: "availability",
            availableQuantity: 5,
            totalQuantity: 5,
            staffReservedCount: 0,
            availableWithoutStaffReservations: 5,
            staffReservationFrom: null,
            staffReservationTo: null,
          };
        }
        if (intent === "prepare") {
          const assetId = String(formData.get("assetId"));
          const quantity = Number(formData.get("quantity"));
          const count = (prepareCounts.get(assetId) ?? 0) + 1;
          prepareCounts.set(assetId, count);
          const title = assetId === "motor" ? "Motor" : "Makey Kit";
          const itemType =
            assetId === "motor" ? "QUANTITY_TRACKED" : "INDIVIDUAL";
          return {
            ok: true,
            intent: "prepared",
            proposal: {
              confirmationToken: `${assetId}-proposal-${count}`,
              operationId: `${assetId}-operation-${count}`,
              asset: {
                id: assetId,
                title,
                type: itemType,
                location: null,
              },
              kit: null,
              quantity,
              selectedPhysicalUnitIds: [],
              availableQuantity: 5,
              from: "2026-10-20T00:00:00.000Z",
              to: "2026-11-20T00:00:00.000Z",
              restriction: null,
              requiresApproval: false,
              requiresStaffPreparation: false,
              staffReservationWarning: null,
            },
          };
        }
        return null;
      },
      Component: () =>
        createElement(
          StudentCheckoutProvider,
          null,
          createElement(IoioCheckout)
        ),
    },
  ]);

  return render(createElement(Stub, { initialEntries: ["/ioio/checkout"] }));
}

it("keeps preparation metadata once and omits global borrowing guidance", async () => {
  renderBorrowingList(true);

  expect(
    await screen.findByRole("heading", { name: "Makey Kit" })
  ).toBeTruthy();
  expect(screen.getByText("5 available · Container A1-1")).toBeTruthy();
  expect(screen.getAllByText("Preparation required")).toHaveLength(1);
  expect(
    screen.getAllByText(
      "A TA will prepare this item for pickup and notify you when it's ready."
    )
  ).toHaveLength(1);
  expect(screen.getAllByText(/Maximum 45 days · Return by/)).toHaveLength(1);
  expect(screen.queryByText("Opening hours")).toBeNull();
  expect(screen.queryByText("Preparation & pickup")).toBeNull();
  expect(screen.queryByText("Extensions")).toBeNull();
  expect(screen.getByRole("button", { name: /I have the kit/ })).toBeTruthy();
  expect(screen.getByRole("button", { name: /Prepare for me/ })).toBeTruthy();
  expect(screen.getByText("Quantity")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Remove" })).toBeTruthy();
});

it("shows only one concise availability summary without preparation", async () => {
  renderBorrowingList(false);

  expect(
    await screen.findByRole("heading", { name: "Makey Kit" })
  ).toBeTruthy();
  expect(screen.getByText("5 available · Container A1-1")).toBeTruthy();
  expect(screen.getAllByText("Available now")).toHaveLength(1);
  expect(
    screen.getAllByText("You can take this item immediately after confirming.")
  ).toHaveLength(1);
  expect(screen.getAllByText(/Maximum 45 days · Return by/)).toHaveLength(1);
  expect(screen.queryByText(/Ready to borrow/)).toBeNull();
  expect(screen.queryByText("Available: 5")).toBeNull();
});

it("supports quantity changes and removal through the shared borrower checkout", async () => {
  renderBorrowingList(false, { itemType: "QUANTITY_TRACKED" });

  await screen.findByRole("heading", { name: "Motor" });
  fireEvent.click(
    screen.getByRole("button", { name: "Increase quantity for motor" })
  );
  expect(screen.getByLabelText("quantity for Motor 2")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Remove" }));
  await waitFor(() => {
    expect(screen.queryByRole("heading", { name: "Motor" })).toBeNull();
  });
});

it("omits the empty proposal container for a normal asset", async () => {
  const { container } = renderBorrowingList(false, {
    itemType: "QUANTITY_TRACKED",
    loadProposal: true,
  });

  await screen.findByRole("heading", { name: "Motor" });
  const card = container.querySelector("article");
  expect(card).toBeTruthy();
  expect(await screen.findByText(/Return by 20 Nov 2026/)).toBeTruthy();
  expect(card?.querySelector("div.rounded-xl.bg-gray-50")).toBeNull();
});

it("keeps the proposal container when a reservation warning needs it", async () => {
  const { container } = renderBorrowingList(false, {
    itemType: "QUANTITY_TRACKED",
    loadProposal: true,
    reservationWarning: true,
  });

  await screen.findByRole("heading", { name: "Motor" });
  expect(
    await screen.findByText(/1 of 5 units are reserved from/)
  ).toBeTruthy();
  expect(
    container.querySelector("article div.rounded-xl.bg-gray-50")
  ).toBeTruthy();
});

it("keeps proposals associated with their cart item as mode and quantity change", async () => {
  const { container } = renderMixedBorrowingList();
  const getBatch = () => {
    const input = container.querySelector<HTMLInputElement>(
      'input[name="proposals"]'
    );
    if (!input) throw new Error("The borrowing proposal list is not rendered.");
    return JSON.parse(input.value) as Array<Record<string, unknown>>;
  };

  await screen.findByRole("heading", { name: "Motor" });
  await waitFor(() => {
    expect(getBatch()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "borrow",
          itemId: "motor",
          confirmationToken: "motor-proposal-1",
          quantity: 1,
        }),
        expect.objectContaining({
          kind: "preparation",
          itemId: "makey-kit",
          assetId: "makey-kit",
          submissionToken: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        }),
      ])
    );
  });

  fireEvent.click(screen.getByRole("button", { name: /I have the kit/ }));
  fireEvent.click(screen.getByRole("button", { name: /Prepare for me/ }));
  await waitFor(() => {
    expect(getBatch()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "borrow",
          itemId: "motor",
          confirmationToken: "motor-proposal-1",
        }),
        expect.objectContaining({
          kind: "preparation",
          itemId: "makey-kit",
          assetId: "makey-kit",
          submissionToken: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        }),
      ])
    );
  });

  fireEvent.click(
    screen.getByRole("button", { name: "Increase quantity for motor" })
  );
  await waitFor(() => {
    expect(getBatch()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "borrow",
          itemId: "motor",
          confirmationToken: "motor-proposal-2",
          quantity: 2,
        }),
        expect.objectContaining({
          kind: "preparation",
          itemId: "makey-kit",
          assetId: "makey-kit",
          submissionToken: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          quantity: 1,
        }),
      ])
    );
  });
});

it("submits the selected basket quantity through the confirmation action", async () => {
  const form = new FormData();
  form.set("intent", "confirm-all");
  form.set(
    "proposals",
    JSON.stringify([
      {
        kind: "borrow",
        itemId: "arduino",
        confirmationToken: "proposal-token",
        quantity: 3,
        selectedPhysicalUnitIds: [],
      },
    ])
  );

  const result = await action({
    context: { getSession: () => ({ userId: "student-1" }) } as never,
    request: new Request("http://localhost/ioio/checkout", {
      method: "POST",
      body: form,
    }),
    params: {},
  } as never);

  expect(result.data).toMatchObject({
    ok: true,
    intent: "confirmed-all",
    results: [{ itemId: "arduino", ok: true, quantity: 3 }],
  });
  expect(mocks.borrowItem).toHaveBeenCalledWith(
    expect.objectContaining({
      confirmationToken: "proposal-token",
      quantity: 3,
      selectedPhysicalUnitIds: [],
    }),
    expect.any(Object)
  );
});

it("submits Motor and Makey Kit preparation as separate basket entries", async () => {
  const form = new FormData();
  form.set("intent", "confirm-all");
  form.set(
    "proposals",
    JSON.stringify([
      {
        kind: "preparation",
        itemId: "makey-kit",
        assetId: "makey-kit",
        submissionToken: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        candidateAssetIds: ["makey-unit-003"],
        quantity: 1,
      },
      {
        kind: "borrow",
        itemId: "motor",
        confirmationToken: "motor-proposal-token",
        quantity: 1,
        selectedPhysicalUnitIds: [],
      },
    ])
  );

  const result = await action({
    context: { getSession: () => ({ userId: "student-1" }) } as never,
    request: new Request("http://localhost/ioio/checkout", {
      method: "POST",
      body: form,
    }),
    params: {},
  } as never);

  expect(result.data).toMatchObject({
    ok: true,
    intent: "confirmed-all",
    results: [
      {
        itemId: "makey-kit",
        kind: "preparation",
        ok: true,
        requestId: "preparation-request-1",
      },
      { itemId: "motor", kind: "borrow", ok: true },
    ],
  });
  expect(mocks.requestPreparation).toHaveBeenCalledWith(
    expect.objectContaining({
      assetId: "makey-kit",
      quantity: 1,
      submissionToken: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    }),
    expect.any(Object)
  );
  expect(mocks.borrowItem).toHaveBeenCalledWith(
    expect.objectContaining({ confirmationToken: "motor-proposal-token" }),
    expect.any(Object)
  );
});

it("does not report preparation success when canonical request creation fails", async () => {
  mocks.requestPreparation.mockRejectedValue({
    label: "Booking",
    message: "The preparation reservation could not be verified.",
    status: 409,
  });
  const form = new FormData();
  form.set("intent", "confirm-all");
  form.set(
    "proposals",
    JSON.stringify([
      {
        kind: "preparation",
        itemId: "makey-kit",
        assetId: "makey-kit",
        submissionToken: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        candidateAssetIds: ["makey-unit-003"],
        quantity: 1,
      },
    ])
  );

  const result = await action({
    context: { getSession: () => ({ userId: "student-1" }) } as never,
    request: new Request("http://localhost/ioio/checkout", {
      method: "POST",
      body: form,
    }),
    params: {},
  } as never);

  expect(result.data).toMatchObject({
    ok: true,
    intent: "confirmed-all",
    results: [
      {
        itemId: "makey-kit",
        ok: false,
        error: "The preparation reservation could not be verified.",
      },
    ],
  });
});

it("submits scanned Makey Kit and Motor borrow proposals independently", async () => {
  const form = new FormData();
  form.set("intent", "confirm-all");
  form.set(
    "proposals",
    JSON.stringify([
      {
        kind: "borrow",
        itemId: "makey-kit",
        confirmationToken: "makey-kit-proposal-token",
        quantity: 1,
        selectedPhysicalUnitIds: ["makey-unit-003"],
      },
      {
        kind: "borrow",
        itemId: "motor",
        confirmationToken: "motor-proposal-token",
        quantity: 1,
        selectedPhysicalUnitIds: [],
      },
    ])
  );

  const result = await action({
    context: { getSession: () => ({ userId: "student-1" }) } as never,
    request: new Request("http://localhost/ioio/checkout", {
      method: "POST",
      body: form,
    }),
    params: {},
  } as never);

  expect(result.data).toMatchObject({
    ok: true,
    intent: "confirmed-all",
    results: [
      { itemId: "makey-kit", kind: "borrow", ok: true },
      { itemId: "motor", kind: "borrow", ok: true },
    ],
  });
  expect(mocks.borrowItem).toHaveBeenNthCalledWith(
    1,
    expect.objectContaining({
      confirmationToken: "makey-kit-proposal-token",
      selectedPhysicalUnitIds: ["makey-unit-003"],
    }),
    expect.any(Object)
  );
  expect(mocks.borrowItem).toHaveBeenNthCalledWith(
    2,
    expect.objectContaining({
      confirmationToken: "motor-proposal-token",
      selectedPhysicalUnitIds: [],
    }),
    expect.any(Object)
  );
});

it("keeps an invalid item's failure scoped to it while submitting Motor", async () => {
  mocks.borrowItem.mockImplementation(({ confirmationToken }) =>
    confirmationToken === "invalid-makey-token"
      ? Promise.reject({
          label: "Booking",
          message: "Kit QR identity could not be verified.",
          status: 409,
        })
      : Promise.resolve({
          status: "submitted",
          bookingId: "booking-motor",
          requiresStaffPreparation: false,
        })
  );
  const form = new FormData();
  form.set("intent", "confirm-all");
  form.set(
    "proposals",
    JSON.stringify([
      {
        kind: "borrow",
        itemId: "makey-kit",
        confirmationToken: "invalid-makey-token",
        quantity: 1,
        selectedPhysicalUnitIds: ["makey-unit-003"],
      },
      {
        kind: "borrow",
        itemId: "motor",
        confirmationToken: "motor-proposal-token",
        quantity: 1,
        selectedPhysicalUnitIds: [],
      },
    ])
  );

  const result = await action({
    context: { getSession: () => ({ userId: "student-1" }) } as never,
    request: new Request("http://localhost/ioio/checkout", {
      method: "POST",
      body: form,
    }),
    params: {},
  } as never);

  expect(result.data).toMatchObject({
    ok: true,
    intent: "confirmed-all",
    results: [
      {
        itemId: "makey-kit",
        ok: false,
        error: "Kit QR identity could not be verified.",
      },
      { itemId: "motor", kind: "borrow", ok: true },
    ],
  });
  expect(mocks.borrowItem).toHaveBeenCalledTimes(2);
  expect(mocks.borrowItem).toHaveBeenNthCalledWith(
    2,
    expect.objectContaining({ confirmationToken: "motor-proposal-token" }),
    expect.any(Object)
  );
});

it("allows Staff through the shared checkout route to the canonical borrow service", async () => {
  mocks.requireIoioBorrowerAccess.mockResolvedValue({
    userId: "staff-1",
    organizationId: "ioio-dev",
    role: "ADMIN",
  });
  const form = new FormData();
  form.set("intent", "confirm-all");
  form.set(
    "proposals",
    JSON.stringify([
      {
        kind: "borrow",
        itemId: "motor-small",
        confirmationToken: "staff-proposal-token",
        quantity: 1,
        selectedPhysicalUnitIds: [],
      },
    ])
  );

  const result = await action({
    context: { getSession: () => ({ userId: "staff-1" }) } as never,
    request: new Request("http://localhost/ioio/checkout", {
      method: "POST",
      body: form,
    }),
    params: {},
  } as never);

  expect(result.data).toMatchObject({
    ok: true,
    intent: "confirmed-all",
    results: [{ itemId: "motor-small", kind: "borrow", ok: true }],
  });
  expect(mocks.borrowItem).toHaveBeenCalledWith(
    expect.objectContaining({
      confirmationToken: "staff-proposal-token",
      quantity: 1,
      selectedPhysicalUnitIds: [],
    }),
    expect.any(Object)
  );
  expect(mocks.requireIoioBorrowerAccess).toHaveBeenCalledOnce();
});

it("loads the shared checkout page for Staff without a student-only redirect", async () => {
  mocks.requireIoioBorrowerAccess.mockResolvedValue({
    userId: "staff-1",
    organizationId: "ioio-dev",
    role: "ADMIN",
  });

  const result = await checkoutLoader({
    context: { getSession: () => ({ userId: "staff-1" }) } as never,
    request: new Request("http://localhost/ioio/checkout"),
    params: {},
  } as never);

  expect(mocks.requireIoioBorrowerAccess).toHaveBeenCalledOnce();
  expect(result.data).toEqual({ error: null, userId: "staff-1" });
});

it.each([
  "http://127.0.0.1:3000/qr/vdqo0i7hk9",
  "http://localhost:3000/qr/vdqo0i7hk9",
  "/qr/vdqo0i7hk9",
])(
  "resolves scanner input to a physical asset in Staff checkout: %s",
  async (value) => {
    const form = new FormData();
    form.set("intent", "resolve-qr");
    form.set("assetId", "logical-makey");
    form.set("candidateAssetIds", "unit-003,unit-004");
    form.set("qrId", value);

    const result = await action({
      context: { getSession: () => ({ userId: "student-1" }) } as never,
      request: new Request("http://localhost/ioio/checkout", {
        method: "POST",
        body: form,
      }),
      params: {},
    } as never);

    expect(result.data).toMatchObject({
      ok: true,
      intent: "qr-resolved",
      unit: {
        id: "unit-003",
        title: "Makey Kit #003",
        unitNumber: "003",
      },
      qrId: "vdqo0i7hk9",
    });
    expect(mocks.qrFindFirst).toHaveBeenCalledWith({
      where: { id: "vdqo0i7hk9", organizationId: "ioio-dev" },
      select: { assetId: true },
    });
    expect(mocks.resolvePhysicalUnitNumber).toHaveBeenCalledWith(
      expect.objectContaining({
        assetId: "logical-makey",
        candidateAssetIds: ["unit-003", "unit-004"],
        unitNumber: "#003",
      }),
      expect.any(Object)
    );
  }
);

it("rejects a scanned QR that resolves to a different inventory item", async () => {
  mocks.assetFindFirst
    .mockResolvedValueOnce({
      title: "Makey Kit",
      type: "INDIVIDUAL",
      assetModelId: "makey-model",
      assetKits: [],
    })
    .mockResolvedValueOnce({
      id: "unit-other",
      title: "Arduino Kit #001",
      assetModelId: "arduino-model",
      assetKits: [],
    });
  mocks.qrFindFirst.mockResolvedValue({ assetId: "unit-other" });
  const form = new FormData();
  form.set("intent", "resolve-qr");
  form.set("assetId", "logical-makey");
  form.set("candidateAssetIds", "unit-003,unit-004");
  form.set("qrId", "vdqo0i7hk9");

  const result = await action({
    context: { getSession: () => ({ userId: "student-1" }) } as never,
    request: new Request("http://localhost/ioio/checkout", {
      method: "POST",
      body: form,
    }),
    params: {},
  } as never);

  expect(result.data).toMatchObject({ ok: false, intent: "error" });
  expect(mocks.resolvePhysicalUnitNumber).not.toHaveBeenCalled();
});

it("resolves a scanned unit through its expected kit membership", async () => {
  mocks.assetFindFirst
    .mockResolvedValueOnce({
      title: "Makey Kit",
      type: "INDIVIDUAL",
      assetModelId: null,
      assetKits: [{ kitId: "makey-kit" }],
    })
    .mockResolvedValueOnce({
      id: "unit-003",
      title: "Makey Kit #003",
      assetModelId: null,
      assetKits: [{ kitId: "makey-kit" }],
    });
  mocks.qrFindFirst.mockResolvedValue({ assetId: "unit-003" });
  const form = new FormData();
  form.set("intent", "resolve-qr");
  form.set("assetId", "logical-makey");
  form.set("candidateAssetIds", "unit-003,unit-004");
  form.set("qrId", "vdqo0i7hk9");

  const result = await action({
    context: { getSession: () => ({ userId: "student-1" }) } as never,
    request: new Request("http://localhost/ioio/checkout", {
      method: "POST",
      body: form,
    }),
    params: {},
  } as never);

  expect(result.data).toMatchObject({
    ok: true,
    intent: "qr-resolved",
    unit: { id: "unit-003" },
  });
});

it("does not accept typed unit numbers as QR possession confirmation", async () => {
  const form = new FormData();
  form.set("intent", "resolve-unit");
  form.set("assetId", "logical-makey");
  form.set("candidateAssetIds", "unit-003,unit-004");
  form.set("unitNumber", "003");

  const result = await action({
    context: { getSession: () => ({ userId: "student-1" }) } as never,
    request: new Request("http://localhost/ioio/checkout", {
      method: "POST",
      body: form,
    }),
    params: {},
  } as never);

  expect(result.data).toMatchObject({ ok: false, intent: "error" });
  expect(mocks.resolvePhysicalUnitNumber).not.toHaveBeenCalled();
});
