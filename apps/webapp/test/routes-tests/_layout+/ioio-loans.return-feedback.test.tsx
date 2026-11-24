import { render, screen } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import { expect, it, vi } from "vitest";
import IoioLoans from "~/routes/_layout+/ioio.loans";

// why: the empty Loans state does not render animation or image content, and
// happy-dom cannot initialize the animation's canvas dependency.
vi.mock("lottie-react", () => ({ default: () => null }));
// why: image rendering requires storage-backed data absent from this empty
// Loans fixture and is unrelated to return feedback.
vi.mock("~/components/assets/asset-image", () => ({
  AssetImage: () => null,
}));

it("shows return feedback and the normal empty Loans state after navigation", async () => {
  const Stub = createRoutesStub([
    {
      path: "/ioio/loans",
      Component: IoioLoans,
      loader: () => ({
        loans: [],
        pendingExtensions: [],
        pendingReturns: [],
        pendingProblemReports: [],
        preparationOperations: [],
        preparationRequests: [],
        cancelledPreparationHistory: [],
        returnZone: null,
        reportSubmitted: false,
      }),
    },
  ]);

  render(<Stub initialEntries={["/ioio/loans?return=submitted"]} />);

  expect(await screen.findByRole("heading", { name: "My loans" })).toBeTruthy();
  expect(screen.getByRole("status")).toHaveTextContent("Return submitted.");
  expect(screen.getByText("No active loans.")).toBeTruthy();
});
