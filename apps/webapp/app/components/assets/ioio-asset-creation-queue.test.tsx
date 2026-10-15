import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  requests: [] as string[],
  failCreateOnceFor: "",
}));

// why: The queue behavior is tested around a lightweight stand-in for Shelf's
// already-tested asset form; this keeps these tests focused on switching,
// preservation, validation ordering, and retry tracking.
vi.mock("./ioio-asset-create-form", () => ({
  IoioAssetCreateForm: (props: any) => (
    <form
      ref={props.onAssetQueueFormRef}
      onInput={(event) =>
        props.onAssetQueueFormChange?.(event.currentTarget as HTMLFormElement)
      }
      onChange={(event) =>
        props.onAssetQueueFormChange?.(event.currentTarget as HTMLFormElement)
      }
      onSubmit={(event) => {
        event.preventDefault();
        const submitter = (event.nativeEvent as SubmitEvent)
          .submitter as HTMLButtonElement | null;
        props.onAssetQueueFormChange?.(event.currentTarget);
        if (submitter?.name === "addAnother") {
          props.onAssetQueueAddAnother?.();
        } else {
          props.onAssetQueueSaveAll?.();
        }
      }}
    >
      <label>
        Name {props.assetQueueDraftId}
        <input
          name="title"
          required
          minLength={2}
          defaultValue={props.title ?? ""}
        />
      </label>
      <label>
        Quantity {props.assetQueueDraftId}
        <input name="quantity" defaultValue={props.quantity ?? ""} />
      </label>
      <label>
        Image {props.assetQueueDraftId}
        <input name="mainImage" type="file" />
      </label>
      <label>
        Category {props.assetQueueDraftId}
        <input name="category" defaultValue={props.categoryId ?? ""} />
      </label>
      <label>
        Advanced option {props.assetQueueDraftId}
        <input name="customField" defaultValue="" />
      </label>
      <button
        type="button"
        name="addAnother"
        value="true"
        onClick={props.onAssetQueueAddAnother}
      >
        Add another
      </button>
      <button type="button" onClick={props.onAssetQueueSaveAll}>
        Save
      </button>
    </form>
  ),
}));

import { IoioAssetCreationQueue } from "./ioio-asset-creation-queue";

async function renderQueue() {
  const router = createMemoryRouter(
    [
      {
        path: "/assets/new",
        element: (
          <IoioAssetCreationQueue
            initialValues={{ title: "", customFields: [] }}
          />
        ),
        loader: () => ({ customFields: [] }),
        HydrateFallback: () => <p>Loading asset form</p>,
        action: async ({ request }) => {
          const formData = await request.formData();
          const draftTitle = String(formData.get("title") ?? "");
          const intent = String(formData.get("assetQueueIntent") ?? "");
          mocked.requests.push(`${intent}:${draftTitle}`);

          if (intent === "validate") {
            return draftTitle.length >= 2
              ? { assetQueueValidated: true }
              : { error: { message: "Name is required" } };
          }

          if (draftTitle === mocked.failCreateOnceFor) {
            mocked.failCreateOnceFor = "";
            return { error: { message: "Temporary create failure" } };
          }

          return { assetQueueCreated: true, createdCount: 1 };
        },
      },
      { path: "/assets", element: <p>Inventory</p> },
    ],
    { initialEntries: ["/assets/new"] }
  );

  render(<RouterProvider router={router} />);
  await screen.findByLabelText("Name asset-draft-1");
  return router;
}

function getDraftItem(title: string) {
  return screen.getByRole("button", {
    name: new RegExp(
      `${title}.*(?:units|unit).*?(?:Editing|Ready|Needs attention)`
    ),
  });
}

describe("IOIO Staff asset creation queue", () => {
  beforeEach(() => {
    mocked.requests.length = 0;
    mocked.failCreateOnceFor = "";
  });

  it("keeps each draft's fields and selected image when switching", async () => {
    await renderQueue();

    fireEvent.change(screen.getByLabelText("Name asset-draft-1"), {
      target: { value: "Makey Kit" },
    });
    fireEvent.change(screen.getByLabelText("Quantity asset-draft-1"), {
      target: { value: "5" },
    });
    fireEvent.change(screen.getByLabelText("Category asset-draft-1"), {
      target: { value: "category-a" },
    });
    fireEvent.change(screen.getByLabelText("Advanced option asset-draft-1"), {
      target: { value: "preserved custom value" },
    });
    const image = new File(["photo"], "makey.png", { type: "image/png" });
    fireEvent.change(screen.getByLabelText("Image asset-draft-1"), {
      target: { files: [image] },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add another" }));

    fireEvent.change(screen.getByLabelText("Name asset-draft-2"), {
      target: { value: "Motor" },
    });
    expect(screen.getByLabelText("Name asset-draft-2")).toHaveValue("Motor");

    fireEvent.click(getDraftItem("Makey Kit"));

    expect(screen.getByLabelText("Name asset-draft-1")).toHaveValue(
      "Makey Kit"
    );
    expect(screen.getByLabelText("Quantity asset-draft-1")).toHaveValue("5");
    expect(screen.getByLabelText("Category asset-draft-1")).toHaveValue(
      "category-a"
    );
    expect(screen.getByLabelText("Advanced option asset-draft-1")).toHaveValue(
      "preserved custom value"
    );
    expect(
      (screen.getByLabelText("Image asset-draft-1") as HTMLInputElement)
        .files?.[0]
    ).toBe(image);
  });

  it("allows incomplete drafts, validates every draft before creating, and removes only the selected draft", async () => {
    await renderQueue();
    fireEvent.click(screen.getByRole("button", { name: "Add another" }));
    fireEvent.change(screen.getByLabelText("Name asset-draft-2"), {
      target: { value: "Motor" },
    });

    expect(screen.getByText("Needs attention")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save all (2)" }));

    await waitFor(() => {
      expect(mocked.requests).toEqual(["validate:"]);
      expect(screen.getByText("Name is required")).toBeTruthy();
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Remove Untitled asset" })
    );
    expect(screen.getByText("Assets to add").parentElement).toHaveTextContent(
      "1"
    );
    expect(screen.getByLabelText("Name asset-draft-2")).toHaveValue("Motor");
  });

  it("validates all five assets before creating and removes successes so retries cannot resubmit them", async () => {
    const router = await renderQueue();
    for (let index = 1; index <= 5; index++) {
      const nameInput = screen.getByLabelText(`Name asset-draft-${index}`);
      fireEvent.change(nameInput, { target: { value: `Asset ${index}` } });
      if (index < 5) {
        fireEvent.click(screen.getByRole("button", { name: "Add another" }));
      }
    }

    fireEvent.click(screen.getByRole("button", { name: "Save all (5)" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/assets"));

    expect(mocked.requests).toEqual([
      "validate:Asset 1",
      "validate:Asset 2",
      "validate:Asset 3",
      "validate:Asset 4",
      "validate:Asset 5",
      "create:Asset 1",
      "create:Asset 2",
      "create:Asset 3",
      "create:Asset 4",
      "create:Asset 5",
    ]);
  });

  it("keeps only uncreated drafts after partial failure so retry skips completed assets", async () => {
    const router = await renderQueue();
    for (let index = 1; index <= 3; index++) {
      fireEvent.change(screen.getByLabelText(`Name asset-draft-${index}`), {
        target: { value: `Asset ${index}` },
      });
      if (index < 3) {
        fireEvent.click(screen.getByRole("button", { name: "Add another" }));
      }
    }
    mocked.failCreateOnceFor = "Asset 3";

    fireEvent.click(screen.getByRole("button", { name: "Save all (3)" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Save all (1)" })).toBeTruthy();
      expect(screen.getByText("Temporary create failure")).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: "Save all (1)" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/assets"));

    expect(mocked.requests).toEqual([
      "validate:Asset 1",
      "validate:Asset 2",
      "validate:Asset 3",
      "create:Asset 1",
      "create:Asset 2",
      "create:Asset 3",
      "validate:Asset 3",
      "create:Asset 3",
    ]);
  });
});
