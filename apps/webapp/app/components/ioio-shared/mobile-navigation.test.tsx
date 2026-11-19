import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Home, Package, ShoppingBasket } from "lucide-react";
import { MemoryRouter, useLocation } from "react-router";
import { describe, expect, it } from "vitest";
import {
  MobileBottomNavigation,
  MobileIoioHeader,
  type MobileNavigationItem,
} from "./mobile-navigation";

const staffItems: MobileNavigationItem[] = [
  { to: "/home", label: "Home", Icon: Home, end: true },
  { to: "/assets", label: "Assets", Icon: Package },
  { to: "/ioio/checkout", label: "Checkout", Icon: ShoppingBasket },
];

const moreItems: MobileNavigationItem[] = [
  { to: "/bookings", label: "Bookings", Icon: Home, group: "Workspace" },
  { to: "/settings", label: "Settings", Icon: Package, group: "Account" },
];

describe("MobileIoioHeader", () => {
  it("contains only the IOIO home link, notifications, and basket actions", () => {
    render(
      <MemoryRouter>
        <MobileIoioHeader
          homeHref="/home"
          notifications={<button type="button">Notifications</button>}
          basket={<a href="/ioio/checkout">Basket</a>}
        />
      </MemoryRouter>
    );

    const header = screen.getByRole("banner");
    expect(
      within(header).getByRole("link", { name: "IOIO Lab home" })
    ).toHaveAttribute("href", "/home");
    expect(
      within(header).getByRole("button", { name: "Notifications" })
    ).toBeInTheDocument();
    expect(
      within(header).getByRole("link", { name: "Basket" })
    ).toHaveAttribute("href", "/ioio/checkout");
    expect(within(header).queryByRole("button", { name: /menu/i })).toBeNull();
    expect(header).toHaveClass("pt-[env(safe-area-inset-top)]");
  });
});

describe("MobileBottomNavigation", () => {
  it("shows Home, Assets, Checkout, and More without Operations", () => {
    render(
      <MemoryRouter initialEntries={["/assets"]}>
        <MobileBottomNavigation
          label="IOIO staff navigation"
          items={staffItems}
          moreItems={moreItems}
        />
      </MemoryRouter>
    );

    const navigation = screen.getByRole("navigation", {
      name: "IOIO staff navigation",
    });
    for (const label of ["Home", "Assets", "Checkout", "More"]) {
      expect(within(navigation).getByText(label)).toBeInTheDocument();
    }
    expect(within(navigation).queryByText("Operations")).toBeNull();
    expect(
      within(navigation).getByRole("link", { name: "Assets" })
    ).toHaveAttribute("aria-current", "page");
    expect(navigation).toHaveClass(
      "inset-x-0",
      "pb-[env(safe-area-inset-bottom)]"
    );
  });

  it("opens More as a bottom sheet and closes after a destination is chosen", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/home"]}>
        <MobileBottomNavigation
          label="IOIO staff navigation"
          items={staffItems}
          moreItems={moreItems}
        />
      </MemoryRouter>
    );

    await user.click(screen.getByRole("button", { name: "More destinations" }));
    const sheet = screen.getByRole("dialog", { name: "More" });
    expect(sheet).toHaveClass(
      "bg-white",
      "w-full",
      "inset-x-0",
      "text-gray-900",
      "rounded-t-2xl",
      "overflow-hidden",
      "pb-[env(safe-area-inset-bottom)]"
    );
    expect(within(sheet).getByRole("button", { name: "Close" })).toHaveClass(
      "size-11",
      "rounded-full",
      "focus-visible:outline-2"
    );
    expect(
      within(sheet).getByRole("navigation", { name: "More destinations" })
    ).toBeInTheDocument();
    const moreNav = within(sheet).getByRole("navigation", {
      name: "More destinations",
    });
    expect(moreNav.parentElement).toHaveClass(
      "overflow-y-auto",
      "overscroll-contain"
    );
    expect(
      within(moreNav).getByRole("heading", { name: "Workspace" })
    ).toBeInTheDocument();
    const bookingsLink = within(moreNav).getByRole("link", {
      name: "Bookings",
    });
    expect(bookingsLink).toHaveClass(
      "grid",
      "min-h-11",
      "grid-cols-[1.125rem_minmax(0,1fr)_1rem]"
    );
    expect(bookingsLink.firstElementChild).toHaveClass("size-[18px]");
    expect(bookingsLink.lastElementChild).toHaveClass(
      "size-4",
      "justify-self-end"
    );

    await user.click(within(sheet).getByRole("link", { name: /Settings/ }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("navigates to every supplied destination, marks it active, and restores focus on dismissal", async () => {
    const user = userEvent.setup();
    function CurrentPath() {
      return <output>{useLocation().pathname}</output>;
    }
    const links = [
      ...moreItems,
      {
        to: "/handbook",
        label: "A long Handbook destination label",
        Icon: Home,
        group: "Browse",
      },
      { to: "/locations", label: "Locations", Icon: Package, group: "Browse" },
    ];
    render(
      <MemoryRouter initialEntries={["/home"]}>
        <MobileBottomNavigation
          label="IOIO navigation"
          items={staffItems}
          moreItems={links}
        />
        <CurrentPath />
      </MemoryRouter>
    );

    const trigger = screen.getByRole("button", { name: "More destinations" });
    for (const { to, label } of links) {
      await user.click(trigger);
      const sheet = screen.getByRole("dialog", { name: "More" });
      await user.click(within(sheet).getByRole("link", { name: label }));
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(screen.getByRole("status")).toHaveTextContent(to);
      expect(trigger).toHaveAttribute("aria-pressed", "true");

      await user.click(trigger);
      expect(screen.getByRole("link", { name: label })).toHaveAttribute(
        "aria-current",
        "page"
      );
      await user.keyboard("{Escape}");
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(trigger).toHaveFocus();
    }

    await user.click(trigger);
    const sheet = screen.getByRole("dialog", { name: "More" });
    await user.click(within(sheet).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(trigger).toHaveFocus();
  });
});
