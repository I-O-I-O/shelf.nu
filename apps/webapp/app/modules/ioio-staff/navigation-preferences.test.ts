import { beforeEach, describe, expect, it } from "vitest";
import {
  getStaffNavigationStorageKey,
  normalizeStaffNavigationOrder,
  readStaffNavigationOrder,
  saveStaffNavigationOrder,
} from "./navigation-preferences";

const defaultOrder = ["dashboard", "inventory", "loans", "archive", "trash"];

describe("staff navigation preferences", () => {
  beforeEach(() => window.localStorage.clear());

  it("uses the canonical order when there is no saved preference", () => {
    expect(normalizeStaffNavigationOrder(null, defaultOrder)).toEqual(
      defaultOrder
    );
  });

  it("preserves a custom order while removing duplicate and stale entries", () => {
    expect(
      normalizeStaffNavigationOrder(
        ["loans", "removed", "dashboard", "loans"],
        defaultOrder
      )
    ).toEqual(["inventory", "loans", "dashboard", "archive", "trash"]);
  });

  it("falls back to the canonical order when saved data has no known items", () => {
    expect(
      normalizeStaffNavigationOrder(["removed", 17, null], defaultOrder)
    ).toEqual(defaultOrder);
  });

  it("adds future navigation items near their canonical position", () => {
    expect(
      normalizeStaffNavigationOrder(
        ["dashboard", "loans", "archive", "trash"],
        ["dashboard", "inventory", "categories", "loans", "archive", "trash"]
      )
    ).toEqual([
      "dashboard",
      "inventory",
      "categories",
      "loans",
      "archive",
      "trash",
    ]);
  });

  it("drops removed inventory shortcuts from existing saved orders", () => {
    expect(
      normalizeStaffNavigationOrder(
        [
          "/home",
          "/staff/ask",
          "/staff/organize",
          "/staff/import",
          "/handbook",
          "/assets",
        ],
        ["/home", "/staff/ask", "/handbook", "/assets"]
      )
    ).toEqual(["/home", "/staff/ask", "/handbook", "/assets"]);
  });

  it("scopes storage by user and organization and restores only that preference", () => {
    const userOneOrgOne = getStaffNavigationStorageKey("user-1", "org-1");
    const userTwoOrgOne = getStaffNavigationStorageKey("user-2", "org-1");
    const userOneOrgTwo = getStaffNavigationStorageKey("user-1", "org-2");

    saveStaffNavigationOrder(userOneOrgOne, ["loans", "dashboard"]);

    expect(readStaffNavigationOrder(userOneOrgOne, defaultOrder)).toEqual([
      "inventory",
      "loans",
      "dashboard",
      "archive",
      "trash",
    ]);
    expect(readStaffNavigationOrder(userTwoOrgOne, defaultOrder)).toEqual(
      defaultOrder
    );
    expect(readStaffNavigationOrder(userOneOrgTwo, defaultOrder)).toEqual(
      defaultOrder
    );
  });

  it("falls back safely when browser storage contains malformed JSON", () => {
    const key = getStaffNavigationStorageKey("user-1", "org-1");
    window.localStorage.setItem(key, "not-json");

    expect(readStaffNavigationOrder(key, defaultOrder)).toEqual(defaultOrder);
  });
});
