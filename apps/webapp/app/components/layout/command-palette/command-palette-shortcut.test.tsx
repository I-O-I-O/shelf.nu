import type { ReactNode } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  layoutData: { isIoioStaff: true },
}));

// why: shortcut behavior can be tested without mounting route loaders, search,
// date formatting, or the real command-dialog primitive.
vi.mock("react-router", () => ({
  useNavigate: () => vi.fn(),
  useRouteLoaderData: () => mocks.layoutData,
}));
vi.mock("~/components/shared/command", () => ({
  CommandDialog: ({
    open,
    children,
  }: {
    open: boolean;
    children: ReactNode;
  }) => (open ? <div data-testid="command-palette">{children}</div> : null),
  CommandEmpty: ({ children }: { children: ReactNode }) => <>{children}</>,
  CommandGroup: ({ children }: { children: ReactNode }) => <>{children}</>,
  CommandInput: () => null,
  CommandItem: ({ children }: { children: ReactNode }) => <>{children}</>,
  CommandList: ({ children }: { children: ReactNode }) => <>{children}</>,
  CommandShortcut: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("~/components/shared/spinner", () => ({ Spinner: () => null }));
vi.mock("~/hooks/use-api-query", () => ({
  default: () => ({ data: undefined }),
}));
vi.mock("~/hooks/use-auto-focus", () => ({
  useAutoFocus: () => ({ current: null }),
}));
vi.mock("~/hooks/use-date-formatter", () => ({
  useDateFormatter: () => ({ formatDate: (date: Date) => date.toISOString() }),
}));
vi.mock("~/hooks/user-user-role-helper", () => ({
  useUserRoleHelper: () => ({ isBaseOrSelfService: false }),
}));

import { CommandPalette } from "./command-palette";
import { CommandPaletteProvider } from "./command-palette-context";

describe("CommandPalette keyboard shortcut", () => {
  afterEach(() => cleanup());

  it("does not open on ⌘K in the IOIO Staff shell", () => {
    mocks.layoutData = { isIoioStaff: true };
    render(
      <CommandPaletteProvider>
        <CommandPalette />
      </CommandPaletteProvider>
    );

    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(screen.queryByTestId("command-palette")).toBeNull();
  });

  it("keeps ⌘K available on non-IOIO Shelf surfaces", () => {
    mocks.layoutData = { isIoioStaff: false };
    render(
      <CommandPaletteProvider>
        <CommandPalette />
      </CommandPaletteProvider>
    );

    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(screen.getByTestId("command-palette")).toBeTruthy();
  });
});
