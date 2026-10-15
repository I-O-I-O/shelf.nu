import { render, screen, waitFor } from "@testing-library/react";
import { Provider, useAtomValue } from "jotai";
import { MemoryRouter, useLocation } from "react-router";
import { describe, expect, it } from "vitest";
import { notificationAtom } from "~/atoms/notifications";
import { TAHoursNoticeConsumer } from "./ta-hours-notice-consumer";

function CurrentLocation() {
  const location = useLocation();
  const notification = useAtomValue(notificationAtom);

  return (
    <>
      <output data-testid="search">{location.search}</output>
      <output data-testid="toast">{notification.message}</output>
    </>
  );
}

describe("TAHoursNoticeConsumer", () => {
  it("shows a shared success toast and removes only the notice query parameter", async () => {
    render(
      <Provider>
        <MemoryRouter
          initialEntries={[
            "/ta-hours?year=2026-2027&view=overview&notice=allocation&filter=active",
          ]}
        >
          <TAHoursNoticeConsumer budgetWarning={null} />
          <CurrentLocation />
        </MemoryRouter>
      </Provider>
    );

    await waitFor(() => {
      expect(screen.getByTestId("toast").textContent).toBe(
        "TA allocation saved."
      );
      expect(screen.getByTestId("search").textContent).toBe(
        "?year=2026-2027&view=overview&filter=active"
      );
    });
  });

  it("cleans unknown stale notices without showing a success toast", async () => {
    render(
      <Provider>
        <MemoryRouter initialEntries={["/ta-hours?notice=removed"]}>
          <TAHoursNoticeConsumer budgetWarning={null} />
          <CurrentLocation />
        </MemoryRouter>
      </Provider>
    );

    await waitFor(() => {
      expect(screen.getByTestId("search").textContent).toBe("");
    });
    expect(screen.getByTestId("toast").textContent).toBe("");
  });

  it("uses transient budget feedback instead of the ordinary success message", async () => {
    render(
      <Provider>
        <MemoryRouter initialEntries={["/ta-hours?notice=confirmed"]}>
          <TAHoursNoticeConsumer budgetWarning="TA hour budget exceeded by 11 h." />
          <CurrentLocation />
        </MemoryRouter>
      </Provider>
    );

    await waitFor(() => {
      expect(screen.getByTestId("toast").textContent).toBe(
        "TA hour budget exceeded by 11 h."
      );
      expect(screen.getByTestId("search").textContent).toBe("");
    });
  });
});
