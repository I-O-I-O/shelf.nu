import { vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAccess: vi.fn(),
  upload: vi.fn(),
}));

// why: access control is owned by the shared Handbook authorization service;
// this test verifies the upload route only proceeds with its returned workspace.
vi.mock("~/modules/ioio-handbook/access.server", () => ({
  requireIoioHandbookRead: mocks.requireAccess,
}));
// why: Supabase is external storage and must not be contacted by this route test.
vi.mock("~/integrations/supabase/client", () => ({
  getSupabaseAdmin: () => ({
    storage: { from: () => ({ upload: mocks.upload }) },
  }),
}));

import sharp from "sharp";
import { action } from "~/routes/api+/handbook-image-upload";

function args(formData: FormData) {
  return {
    context: { getSession: () => ({ userId: "user-1" }) },
    request: new Request("https://app.example/api/handbook-image-upload", {
      method: "POST",
      body: formData,
    }),
  } as never;
}

async function validPng() {
  return sharp({
    create: {
      width: 1,
      height: 1,
      channels: 3,
      background: { r: 20, g: 80, b: 160 },
    },
  })
    .png()
    .toBuffer();
}

describe("Handbook inline image upload route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAccess.mockResolvedValue({
      organizationId: "org-1",
      currentOrganization: { type: "TEAM" },
    });
    mocks.upload.mockResolvedValue({ error: null });
  });

  it("stores a decoded image under its organization and returns an inline reference", async () => {
    const form = new FormData();
    form.set(
      "image",
      new File([await validPng()], "printer.png", { type: "image/png" })
    );

    const response = (await action(args(form))) as {
      data: { ok: boolean; src: string };
    };

    expect(response.data.ok).toBe(true);
    expect(response.data.src).toMatch(
      /^\/api\/handbook-image\?path=handbook%2Forg-1%2F[0-9a-f-]{36}\.png$/u
    );
    expect(mocks.upload).toHaveBeenCalledWith(
      expect.stringMatching(/^handbook\/org-1\/[0-9a-f-]{36}\.png$/u),
      expect.any(Buffer),
      { contentType: "image/png", upsert: false }
    );
  });

  it("rejects files over 2 MB before storing them", async () => {
    const form = new FormData();
    form.set(
      "image",
      new File([new Uint8Array(2 * 1024 * 1024 + 1)], "large.png", {
        type: "image/png",
      })
    );

    const response = (await action(args(form))) as {
      data: { ok: boolean; message: string };
      init: { status: number };
    };

    expect(response.data.ok).toBe(false);
    expect(response.data.message).toContain("2 MB");
    expect(response.init.status).toBe(413);
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it("rejects signature-only or mismatched MIME uploads", async () => {
    const form = new FormData();
    form.set(
      "image",
      new File(
        [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
        "fake.png",
        { type: "image/png" }
      )
    );

    const response = (await action(args(form))) as {
      data: { ok: boolean; message: string };
    };

    expect(response.data.ok).toBe(false);
    expect(response.data.message).toContain("valid PNG");
    expect(mocks.upload).not.toHaveBeenCalled();
  });
});
