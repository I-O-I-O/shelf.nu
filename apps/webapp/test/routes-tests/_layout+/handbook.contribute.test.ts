import { beforeEach, describe, expect, it, vi } from "vitest";
import { createActionArgs, createLoaderArgs } from "@mocks/remix";

const mocks = vi.hoisted(() => ({
  editorAction: vi.fn(),
}));

// why: the legacy contribution URL now delegates to the shared article editor
// flow, so the route test verifies routing without needing a session or DB.
vi.mock("~/modules/ioio-handbook/editor.server", () => ({
  handbookEditorAction: mocks.editorAction,
}));

import { action, loader } from "~/routes/_layout+/handbook.contribute";

describe("legacy Handbook contribution route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.editorAction.mockResolvedValue({ ok: true });
  });

  it("redirects direct navigation to the normal article create route", () => {
    const result = loader(
      createLoaderArgs({
        request: new Request(
          "http://localhost/handbook/contribute?from=handbook"
        ),
      })
    );

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(302);
    expect((result as Response).headers.get("Location")).toBe(
      "/handbook/new?from=handbook"
    );
  });

  it("uses the normal draft save action for a stale form submission", async () => {
    const args = createActionArgs({
      request: new Request("http://localhost/handbook/contribute", {
        method: "POST",
      }),
    });

    await action(args);

    expect(mocks.editorAction).toHaveBeenCalledWith(args);
  });
});
