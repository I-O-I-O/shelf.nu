import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Provider, useAtomValue, useSetAtom } from "jotai";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { assetImageValidateFileAtom, fileErrorAtom } from "~/atoms/file";
import {
  ACCEPT_SUPPORTED_IMAGES,
  ASSET_MAX_IMAGE_UPLOAD_SIZE,
} from "~/utils/constants";
import { IoioImagePicker } from "./ioio-image-picker";

function EditImage({
  onUploaded = vi.fn(),
}: {
  onUploaded?: (file: File | null) => void;
}) {
  const validate = useSetAtom(assetImageValidateFileAtom);
  const error = useAtomValue(fileErrorAtom);
  return (
    <form>
      <input aria-label="Title" />
      <IoioImagePicker
        name="mainImage"
        accept={ACCEPT_SUPPORTED_IMAGES}
        existingPreview={<img src="/existing.webp" alt="Saved cover" />}
        pasteImages
        pasteUploadUrl="/api/inventory-image-upload?kind=asset&id=asset-1"
        validatePaste={validate}
        onPasteSuccess={onUploaded}
        onChange={validate}
        error={error}
      />
      <button type="submit">Save</button>
    </form>
  );
}

function paste(file?: File) {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: {
      items: file
        ? [{ kind: "file", type: file.type, getAsFile: () => file }]
        : [{ kind: "string", type: "text/plain" }],
    },
  });
  fireEvent(screen.getByLabelText("Title"), event);
  return event;
}

function image(type = "image/png", size = 16) {
  return new File([new Uint8Array(size)], "clipboard.png", { type });
}

beforeEach(() => {
  // why: happy-dom has no object URL implementation for local image previews.
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:preview");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

it.each(["image/png", "image/jpeg", "image/webp"])(
  "uploads %s immediately, preserves the saved image until success, and permits Save afterward",
  async (type) => {
    let finish!: (response: Response) => void;
    // why: control external storage HTTP to exercise the in-flight state.
    const upload = vi.spyOn(globalThis, "fetch").mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const onUploaded = vi.fn();
    render(
      <Provider>
        <EditImage onUploaded={onUploaded} />
      </Provider>
    );
    const file = image(type);
    expect(paste(file).defaultPrevented).toBe(true);
    expect(screen.getByRole("status")).toHaveTextContent("Uploading image");
    expect(screen.getByAltText("Saved cover")).toBeVisible();
    const input = screen.getByLabelText("Main image") as HTMLInputElement;
    const form = input.form!;
    expect(
      form.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true })
      )
    ).toBe(false);
    expect(upload).toHaveBeenCalledWith(
      "/api/inventory-image-upload?kind=asset&id=asset-1",
      { method: "POST", body: expect.any(FormData) }
    );
    expect(
      (upload.mock.calls[0][1]?.body as FormData).get("mainImage")
    ).toBeInstanceOf(File);
    finish(new Response(JSON.stringify({ success: true })));
    await waitFor(() =>
      expect(screen.getByAltText("Selected upload preview")).toHaveAttribute(
        "src",
        "blob:preview"
      )
    );
    expect(onUploaded).toHaveBeenCalledWith(file);
    expect(input.files).toHaveLength(0);
    expect(form.dispatchEvent(new Event("submit", { cancelable: true }))).toBe(
      true
    );
  }
);

it("supports another replacement and keeps that preview when a subsequent upload fails", async () => {
  // why: simulate successful canonical replacement followed by a storage failure.
  const upload = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ success: true })))
    );
  render(
    <Provider>
      <EditImage />
    </Provider>
  );
  paste(image());
  await screen.findByAltText("Selected upload preview");
  paste(image("image/webp"));
  await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalledTimes(2));
  upload.mockResolvedValueOnce(
    new Response(JSON.stringify({ error: "Storage unavailable" }), {
      status: 503,
    })
  );
  paste(image());
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Storage unavailable"
  );
  expect(screen.getByAltText("Selected upload preview")).toBeVisible();
  expect(URL.createObjectURL).toHaveBeenCalledTimes(2);
});

it.each([
  ["image/gif", 16, "Allowed file types"],
  ["image/png", ASSET_MAX_IMAGE_UPLOAD_SIZE + 1, "Max file size"],
] as const)(
  "rejects invalid clipboard image %s / %s",
  async (type, size, message) => {
    // why: invalid files must be rejected before any external upload.
    const upload = vi.spyOn(globalThis, "fetch");
    render(
      <Provider>
        <EditImage />
      </Provider>
    );
    paste(image(type, size));
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(screen.getByAltText("Saved cover")).toBeVisible();
    expect(upload).not.toHaveBeenCalled();
  }
);

it("leaves text paste untouched and still accepts a picked file", async () => {
  render(
    <Provider>
      <EditImage />
    </Provider>
  );
  expect(paste().defaultPrevented).toBe(false);
  await userEvent.upload(screen.getByLabelText("Main image"), image());
  expect(screen.getByAltText("Selected upload preview")).toBeVisible();
  expect(
    (screen.getByLabelText("Main image") as HTMLInputElement).files
  ).toHaveLength(1);
});

it("uploads a files-only clipboard image when the edit page has focus", async () => {
  // why: replace external upload HTTP with a successful storage response.
  const upload = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response(JSON.stringify({ success: true })));
  render(
    <Provider>
      <EditImage />
    </Provider>
  );
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: { items: [], files: [image()] },
  });
  fireEvent(document.body, event);
  expect(event.defaultPrevented).toBe(true);
  await screen.findByAltText("Selected upload preview");
  expect(upload).toHaveBeenCalledTimes(1);
});

it("does not claim page paste while a different form or dialog owns it", () => {
  // why: unrelated form/dialog paste must never send external upload HTTP.
  const upload = vi.spyOn(globalThis, "fetch");
  render(
    <Provider>
      <EditImage />
      <form>
        <input aria-label="Other notes" />
      </form>
      <dialog open>Other dialog</dialog>
    </Provider>
  );
  for (const target of [screen.getByLabelText("Other notes"), document.body]) {
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: { items: [], files: [image()] },
    });
    fireEvent(target, event);
    expect(event.defaultPrevented).toBe(false);
  }
  expect(upload).not.toHaveBeenCalled();
});

it("reports a useful error for a non-JSON server failure and keeps the saved image", async () => {
  // why: a proxy or expired-session HTML response is an external upload failure.
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response("<html>unavailable</html>", { status: 503 })
  );
  render(
    <Provider>
      <EditImage />
    </Provider>
  );
  paste(image());
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Image upload failed. Try again."
  );
  expect(screen.getByAltText("Saved cover")).toBeVisible();
});

it("pastes into the visible draft without uploading to a hidden queued form", async () => {
  // why: external upload HTTP is controlled to verify the destination count.
  const upload = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response(JSON.stringify({ success: true })));
  render(
    <Provider>
      <div hidden>
        <EditImage />
      </div>
      <EditImage />
    </Provider>
  );
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: { items: [], files: [image()] },
  });
  fireEvent(document.body, event);
  await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
  expect(await screen.findByAltText("Selected upload preview")).toBeVisible();
});

it("leaves ambiguous page paste alone when multiple image forms are visible", () => {
  // why: no external upload may be sent to an ambiguous image target.
  const upload = vi.spyOn(globalThis, "fetch");
  render(
    <Provider>
      <EditImage />
      <EditImage />
    </Provider>
  );
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: { items: [], files: [image()] },
  });
  fireEvent(document.body, event);
  expect(event.defaultPrevented).toBe(false);
  expect(upload).not.toHaveBeenCalled();
});
