/**
 * <ImageFileField> - unit tests
 *
 * Covers what the user sees next to an image file input:
 *  - the saved image the caller passes in, until a file is picked,
 *  - a local preview of a picked file, before anything is uploaded,
 *  - the saved image again when the picked file fails validation (the
 *    validator clears the input, so nothing would be uploaded),
 *  - object URLs released when replaced and on unmount,
 *  - the format hint describing the input once,
 *  - no picture at all when there is no saved image, until a file is picked,
 *  - the caller's validation rules, hint and extra content,
 *  - the caller told which file will be uploaded after each pick,
 *  - the field name, error and disabled state reaching the input.
 *
 * @see {@link file://./image-file-field.tsx}
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createStore, Provider } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assetImageValidateFileAtom, fileErrorAtom } from "~/atoms/file";
import {
  ASSET_MAX_IMAGE_UPLOAD_SIZE,
  DEFAULT_MAX_IMAGE_UPLOAD_SIZE,
} from "~/utils/constants";
import { ImageFileField } from "./image-file-field";

type FieldProps = Parameters<typeof ImageFileField>[0];

/** Renders the field in its own jotai store so validation state never leaks. */
function renderField(props: Partial<FieldProps> = {}) {
  const store = createStore();
  const result = render(
    <Provider store={store}>
      <form>
        <input aria-label="Description" />
        <ImageFileField
          name="image"
          label="Main image"
          previewAlt="Picked file"
          currentImage={<img src="/saved.png" alt="Saved logo" />}
          {...props}
        />
        <button type="submit">Save</button>
      </form>
    </Provider>
  );
  return { ...result, store };
}

/** The file input, found by its (visually hidden) label. */
function fileInput() {
  return screen.getByLabelText("Main image") as HTMLInputElement;
}

/**
 * Builds a PNG `File` of a given byte size.
 *
 * @param name - File name (keep it clean so the validator does not rename it)
 * @param size - Size in bytes; above the 4 MB limit the validator rejects it
 */
function pngFile(name: string, size = 1024) {
  return new File([new Uint8Array(size)], name, { type: "image/png" });
}

function pasteImage(file: File) {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: {
      items: [{ kind: "file", type: file.type, getAsFile: () => file }],
    },
  });
  fireEvent(screen.getByLabelText("Description"), event);
}

const TOO_BIG = DEFAULT_MAX_IMAGE_UPLOAD_SIZE + 1;
let objectUrlCount = 0;

beforeEach(() => {
  objectUrlCount = 0;
  // why: happy-dom does not implement object URLs.
  globalThis.URL.createObjectURL = vi.fn(() => `blob:mock-${++objectUrlCount}`);
  globalThis.URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ImageFileField", () => {
  it.each(["mainImage", "image"])(
    "uploads pasted %s through multipart and replaces the preview only after success",
    async (name) => {
      let finish!: (response: Response) => void;
      // why: upload HTTP is external; control completion to test pending and success states.
      const upload = vi.spyOn(globalThis, "fetch").mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          })
      );
      const changed = vi.fn();
      renderField({
        name,
        pasteImages: true,
        pasteUploadUrl: "/api/inventory-image-upload?kind=asset&id=one",
        onFileChange: changed,
      });
      const file = pngFile("pasted.png");
      pasteImage(file);
      expect(screen.getByText("Uploading image…")).toBeInTheDocument();
      expect(screen.getByAltText("Saved logo")).toBeInTheDocument();
      expect(fileInput()).toBeDisabled();
      const body = upload.mock.calls[0][1]?.body as FormData;
      expect(body.get(name)).toBeInstanceOf(File);
      expect((body.get(name) as File).name).toBe("pasted.png");
      expect(
        fileInput()
          .closest("form")!
          .dispatchEvent(
            new Event("submit", { bubbles: true, cancelable: true })
          )
      ).toBe(false);
      finish(new Response(JSON.stringify({ success: true })));
      await waitFor(() =>
        expect(screen.getByAltText("Picked file")).toHaveAttribute(
          "src",
          "blob:mock-1"
        )
      );
      expect(fileInput()).not.toBeDisabled();
      expect(fileInput().files).toHaveLength(0);
      expect(changed).toHaveBeenCalledWith(file);
    }
  );

  it("keeps the current preview and reports a failed upload", async () => {
    // why: simulate storage failure without network access.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "Storage unavailable" }), {
        status: 503,
      })
    );
    renderField({
      pasteImages: true,
      pasteUploadUrl: "/api/inventory-image-upload",
    });
    const file = pngFile("pasted.png");
    pasteImage(file);
    expect(await screen.findByText("Storage unavailable")).toBeInTheDocument();
    expect(screen.getByAltText("Saved logo")).toBeInTheDocument();
    expect(screen.queryByAltText("Picked file")).toBeNull();
  });

  it("replaces an uploaded paste with a second image and releases the previous preview", async () => {
    // why: storage HTTP is external; successful responses exercise repeated replacement.
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ success: true })))
    );
    renderField({
      pasteImages: true,
      pasteUploadUrl: "/api/inventory-image-upload",
    });
    pasteImage(pngFile("first.png"));
    await waitFor(() =>
      expect(screen.getByAltText("Picked file")).toHaveAttribute(
        "src",
        "blob:mock-1"
      )
    );
    pasteImage(pngFile("second.png"));
    await waitFor(() =>
      expect(screen.getByAltText("Picked file")).toHaveAttribute(
        "src",
        "blob:mock-2"
      )
    );
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:mock-1");
  });

  it("leaves text paste untouched and ignores images outside its owning form", () => {
    renderField({ pasteImages: true });
    const text = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(text, "clipboardData", {
      value: { items: [{ kind: "string", type: "text/plain" }] },
    });
    expect(screen.getByLabelText("Description").dispatchEvent(text)).toBe(true);
    const outside = new Event("paste", { bubbles: true, cancelable: true });
    expect(document.body.dispatchEvent(outside)).toBe(true);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it.each(["oversize", "unsupported"])(
    "rejects %s clipboard images without uploading or replacing a selection",
    (kind) => {
      // why: rejected clipboard files must never make an HTTP upload request.
      const upload = vi.spyOn(globalThis, "fetch");
      const { store } = renderField({
        pasteImages: true,
        pasteUploadUrl: "/api/inventory-image-upload",
      });
      const file =
        kind === "oversize"
          ? pngFile("huge.png", TOO_BIG)
          : new File(["gif"], "image.gif", { type: "image/gif" });
      pasteImage(file);
      expect(store.get(fileErrorAtom)).toMatch(
        kind === "oversize" ? /Max file size/ : /Allowed file types/
      );
      expect(upload).not.toHaveBeenCalled();
      expect(screen.getByAltText("Saved logo")).toBeInTheDocument();
      expect(screen.queryByAltText("Picked file")).toBeNull();
    }
  );

  it("shows the saved image until a file is picked", () => {
    renderField();

    expect(screen.getByRole("img", { name: "Saved logo" })).toHaveAttribute(
      "src",
      "/saved.png"
    );
    expect(
      screen.queryByRole("img", { name: "Picked file" })
    ).not.toBeInTheDocument();
  });

  it("previews a picked file in place of the saved image", async () => {
    const user = userEvent.setup();
    renderField();
    const file = pngFile("new.png");

    await user.upload(fileInput(), file);

    expect(URL.createObjectURL).toHaveBeenCalledWith(file);
    const preview = screen.getByRole("img", { name: "Picked file" });
    expect(preview).toHaveAttribute("src", "blob:mock-1");
    // Same size and shape as the saved pictures of every image form.
    expect(preview).toHaveClass("size-16", "rounded", "border", "object-cover");
    expect(
      screen.queryByRole("img", { name: "Saved logo" })
    ).not.toBeInTheDocument();
    // The picked file stays in the input, under the caller's field name.
    expect(fileInput().name).toBe("image");
    expect(fileInput().files?.[0]).toBe(file);
  });

  it("keeps the saved image when the picked file is rejected", async () => {
    const user = userEvent.setup();
    renderField();

    await user.upload(fileInput(), pngFile("too-big.png", TOO_BIG));

    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(fileInput().files).toHaveLength(0);
    expect(screen.getByRole("img", { name: "Saved logo" })).toBeVisible();
  });

  it("drops an earlier preview when a later pick is rejected", async () => {
    const user = userEvent.setup();
    renderField();

    await user.upload(fileInput(), pngFile("good.png"));
    await user.upload(fileInput(), pngFile("too-big.png", TOO_BIG));

    // Nothing will be uploaded, so the picture is the saved image again.
    expect(screen.getByRole("img", { name: "Saved logo" })).toBeVisible();
    expect(
      screen.queryByRole("img", { name: "Picked file" })
    ).not.toBeInTheDocument();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:mock-1");
  });

  it("releases each object URL when replaced and on unmount", async () => {
    const user = userEvent.setup();
    const { unmount } = renderField();

    await user.upload(fileInput(), pngFile("first.png"));
    await user.upload(fileInput(), pngFile("second.png"));

    expect(screen.getByRole("img", { name: "Picked file" })).toHaveAttribute(
      "src",
      "blob:mock-2"
    );
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:mock-1");
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith("blob:mock-2");

    unmount();

    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:mock-2");
  });

  it("describes the input with the format hint exactly once", () => {
    renderField();

    // One hint element, referenced once: a second copy would be read twice,
    // even while hidden.
    expect(
      screen.getAllByText("Accepts PNG, JPG, JPEG, or WebP (max.4 MB)")
    ).toHaveLength(1);
    expect(fileInput()).toHaveAccessibleDescription(
      "Accepts PNG, JPG, JPEG, or WebP (max.4 MB)"
    );
  });

  it("shows no picture without a saved image until a file is picked", async () => {
    const user = userEvent.setup();
    renderField({ currentImage: null });

    expect(screen.queryByRole("img")).not.toBeInTheDocument();

    await user.upload(fileInput(), pngFile("new.png"));

    expect(screen.getByRole("img", { name: "Picked file" })).toHaveAttribute(
      "src",
      "blob:mock-1"
    );
  });

  it("applies the caller's validation rules", async () => {
    const user = userEvent.setup();
    renderField({ validateFileAtom: assetImageValidateFileAtom });

    // Over the default 4 MB limit but within the asset image 8 MB limit.
    await user.upload(fileInput(), pngFile("large.png", TOO_BIG));
    expect(screen.getByRole("img", { name: "Picked file" })).toBeVisible();

    await user.upload(
      fileInput(),
      pngFile("too-large.png", ASSET_MAX_IMAGE_UPLOAD_SIZE + 1)
    );
    expect(screen.getByRole("img", { name: "Saved logo" })).toBeVisible();
    expect(fileInput().files).toHaveLength(0);
  });

  it("describes the input with the caller's hint", () => {
    renderField({ hint: "Accepts PNG, JPG, JPEG, or WebP (max.8 MB)" });

    expect(fileInput()).toHaveAccessibleDescription(
      "Accepts PNG, JPG, JPEG, or WebP (max.8 MB)"
    );
  });

  it("renders extra content above and below the input", () => {
    renderField({
      aboveInput: <p>Using the image from the model.</p>,
      belowInput: <p>Used by 3 assets.</p>,
    });

    const above = screen.getByText("Using the image from the model.");
    const below = screen.getByText("Used by 3 assets.");
    // DOCUMENT_POSITION_FOLLOWING: the second node comes after the first.
    expect(above.compareDocumentPosition(fileInput())).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
    expect(fileInput().compareDocumentPosition(below)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
  });

  it("tells the caller which file will be uploaded after each pick", async () => {
    const user = userEvent.setup();
    const onFileChange = vi.fn();
    renderField({ onFileChange });
    const file = pngFile("new.png");

    await user.upload(fileInput(), file);
    expect(onFileChange).toHaveBeenLastCalledWith(file);

    // A rejected pick empties the input: nothing will be uploaded.
    await user.upload(fileInput(), pngFile("too-big.png", TOO_BIG));
    expect(onFileChange).toHaveBeenLastCalledWith(null);
  });

  it("shows the error and passes the disabled state to the input", () => {
    renderField({ error: "Max file size is 4MB", disabled: true });

    expect(screen.getByText("Max file size is 4MB")).toBeVisible();
    expect(fileInput()).toBeDisabled();
  });
});
