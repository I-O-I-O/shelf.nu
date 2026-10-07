import { render, screen } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createLoaderArgs } from "@mocks/remix";

const mocks = vi.hoisted(() => ({
  requirePermission: vi.fn(),
  getStudentAssets: vi.fn(),
  findReservation: vi.fn(),
}));

// why: this route's loader reads the organization and catalog; empty records
// are returned to model a new organization without an initialized database.
vi.mock("~/database/db.server", () => ({
  db: { booking: { findFirst: mocks.findReservation } },
}));
vi.mock("~/utils/roles.server", () => ({
  requirePermission: mocks.requirePermission,
}));
vi.mock("~/modules/ioio-student/service.server", () => ({
  getStudentAssets: mocks.getStudentAssets,
}));
// why: the reservation UI behavior under test is its no-inventory state, not
// the shared date picker, which requires root request-info loader context.
vi.mock("~/components/ioio-student/ioio-date-range-picker", () => ({
  IoioDateRangePicker: () => <div>Date range</div>,
}));
// why: the route's shared error components import a Lottie animation that
// expects canvas support unavailable in happy-dom at module initialization.
vi.mock("lottie-react", () => ({ default: () => null }));

import NewIoioReservation, {
  action,
  loader,
} from "~/routes/_layout+/calendar.new-reservation";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requirePermission.mockResolvedValue({
    organizationId: "org-1",
    role: "OWNER",
    userId: "staff-1",
  });
  mocks.getStudentAssets.mockResolvedValue([]);
  mocks.findReservation.mockResolvedValue(null);
});

describe("staff calendar reservation", () => {
  it("requires staff permissions for reservation routes and actions", async () => {
    mocks.requirePermission.mockResolvedValue({
      organizationId: "org-1",
      role: "SELF_SERVICE",
      userId: "student-1",
    });

    await expect(
      loader(
        createLoaderArgs({
          context: { getSession: () => ({ userId: "student-1" }) },
          request: new Request("http://localhost/calendar/new-reservation"),
        })
      )
    ).rejects.toMatchObject({ status: 403 });

    await expect(
      action(
        createLoaderArgs({
          context: { getSession: () => ({ userId: "student-1" }) },
          request: new Request("http://localhost/calendar/new-reservation", {
            method: "POST",
            body: new FormData(),
          }),
        })
      )
    ).rejects.toMatchObject({ status: 403 });

    expect(mocks.requirePermission).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: "create" })
    );
  });

  it("loads and renders safely when the organization has no inventory", async () => {
    const result = await loader(
      createLoaderArgs({
        context: { getSession: () => ({ userId: "staff-1" }) },
        request: new Request("http://localhost/calendar/new-reservation"),
      })
    );

    expect(result.data).toMatchObject({ products: [], reservation: null });

    const Stub = createRoutesStub([
      {
        path: "/calendar/new-reservation",
        Component: NewIoioReservation,
        loader: () => ({ products: [], reservation: null }),
        HydrateFallback: () => <div>Loading reservation...</div>,
      },
    ]);
    render(<Stub initialEntries={["/calendar/new-reservation"]} />);

    expect(
      await screen.findByText(/No equipment is available to reserve yet/)
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("button", { name: "Create reservation" })
    ).toBeDisabled();
  });
});
