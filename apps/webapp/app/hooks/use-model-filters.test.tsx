import type { ChangeEvent } from "react";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useModelFilters } from "./use-model-filters";

const mocks = vi.hoisted(() => ({
  loaderData: {
    locations: [{ id: "old-location", name: "Old location" }],
    totalLocations: 1,
  },
  searchParams: new URLSearchParams(),
  setSearchParams: vi.fn(),
  fetcher: {
    data: undefined as
      | { filters: Array<{ id: string; name: string }> }
      | undefined,
    reset: vi.fn(() => {
      mocks.fetcher.data = undefined;
    }),
    submit: vi.fn(),
  },
}));

// why: these router hooks supply the route's seeded data and URL state; the
// test isolates how forced server searches replace stale picker results.
vi.mock("react-router", () => ({
  useLoaderData: () => mocks.loaderData,
}));

// why: URL filtering is unrelated to the server-search refresh behavior.
vi.mock("~/hooks/search-params", () => ({
  useSearchParams: () => [mocks.searchParams, mocks.setSearchParams],
}));

// why: the real hook needs a data router; this controllable fetcher models the
// previous result, its reset, and the next server response.
vi.mock("./use-fetcher-with-reset", () => ({
  default: () => mocks.fetcher,
}));

describe("useModelFilters forced server search", () => {
  beforeEach(() => {
    mocks.loaderData = {
      locations: [{ id: "old-location", name: "Old location" }],
      totalLocations: 1,
    };
    mocks.searchParams = new URLSearchParams();
    mocks.setSearchParams.mockClear();
    mocks.fetcher.data = undefined;
    mocks.fetcher.reset.mockClear();
    mocks.fetcher.submit.mockClear();
  });

  it("clears old and loader-seeded matches until the current server search returns", () => {
    const staleResult = { id: "stale-location", name: "Old container" };
    mocks.fetcher.data = { filters: [staleResult] };

    const { result, rerender } = renderHook(() =>
      useModelFilters({
        model: { name: "location", queryKey: "name" },
        initialDataKey: "locations",
        countKey: "totalLocations",
        selectionMode: "none",
        forceServerSearch: true,
      })
    );

    act(() => {
      result.current.handleSearchQueryChange({
        currentTarget: { value: "container" },
      } as ChangeEvent<HTMLInputElement>);
    });

    expect(mocks.fetcher.reset).toHaveBeenCalledOnce();
    expect(mocks.fetcher.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "location",
        queryKey: "name",
        queryValue: "container",
      }),
      expect.objectContaining({ method: "GET", action: "/api/model-filters" })
    );
    expect(result.current.items).toEqual([]);

    const currentResult = { id: "current-location", name: "Container 4" };
    mocks.fetcher.data = { filters: [currentResult] };
    rerender();
    expect(result.current.items).toEqual([currentResult]);

    act(() => {
      result.current.handleSearchQueryChange({
        currentTarget: { value: "shelf" },
      } as ChangeEvent<HTMLInputElement>);
    });

    expect(result.current.items).toEqual([]);
    mocks.fetcher.data = { filters: [] };
    rerender();
    expect(result.current.items).toEqual([]);
  });
});
