import { useState, type ComponentProps } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import { expect, it, vi } from "vitest";
import { StudentPickupForm } from "~/routes/_layout+/ioio.loans";

// why: the Loans route imports an animation whose canvas setup is unsupported
// in happy-dom; the pickup form itself does not render that animation.
vi.mock("lottie-react", () => ({ default: () => null }));
// why: camera hardware is unavailable in happy-dom; expose deterministic
// repeated frame emissions to exercise the real pickup callback/deduplication.
vi.mock("~/components/scanner/code-scanner", () => ({
  CodeScanner: ({
    onCodeDetectionSuccess,
  }: {
    onCodeDetectionSuccess: (result: { value: string; type: string }) => void;
  }) => (
    <div>
      <button
        type="button"
        onClick={() => {
          for (let i = 0; i < 20; i++) {
            onCodeDetectionSuccess({
              value: "http://127.0.0.1:3000/qr/vdqo0i7hk9",
              type: "qr",
            });
          }
        }}
      >
        Emit same QR 20 times
      </button>
      <button
        type="button"
        onClick={() => {
          onCodeDetectionSuccess({
            value: "http://127.0.0.1:3000/qr/vdqo0i7hk9",
            type: "qr",
          });
          onCodeDetectionSuccess({ value: "/qr/vdqo0i7hk9", type: "qr" });
        }}
      >
        Emit equivalent QR forms
      </button>
      <button
        type="button"
        onClick={() => {
          for (let i = 0; i < 20; i++) {
            onCodeDetectionSuccess({
              value: "http://localhost:3000/qr/wrong-unit-004",
              type: "qr",
            });
          }
        }}
      >
        Emit wrong QR 20 times
      </button>
      <button
        type="button"
        onClick={() =>
          onCodeDetectionSuccess({
            value: "/qr/vdqo0i7hk9",
            type: "qr",
          })
        }
      >
        Emit correct QR
      </button>
    </div>
  ),
}));

function PickupFormHarness() {
  const [validationState, setValidationState] =
    useState<ComponentProps<typeof StudentPickupForm>["validationState"]>(null);
  const isValidated =
    validationState?.operationId === "preparation-1" &&
    validationState.validation.valid;

  return (
    <>
      <button
        type="submit"
        form="pickup-form-preparation-1"
        disabled={!isValidated}
        data-testid="top-pickup-action"
      >
        Pick up item
      </button>
      <StudentPickupForm
        operationId="preparation-1"
        formId="pickup-form-preparation-1"
        needsUnitVerification
        validationState={validationState}
        setValidationState={setValidationState}
      />
    </>
  );
}

it("validates a scanned QR inline and checks out with one Pick up item action", async () => {
  const submissions: Array<{
    intent: FormDataEntryValue | null;
    value: FormDataEntryValue | null;
  }> = [];
  const action = vi.fn(async ({ request }: { request: Request }) => {
    const form = await request.formData();
    submissions.push({
      intent: form.get("intent"),
      value: form.get("verificationValue"),
    });
    if (form.get("intent") === "validate-pickup") {
      return {
        ok: true,
        intent: "pickup-validated",
        inputValue: form.get("verificationValue"),
        validation: {
          valid: true,
          status: "valid",
          assignedUnitLabel: "Makey Kit #003",
        },
      };
    }
    return {
      ok: true,
      intent: "pickup-confirmed",
      result: { operationId: "preparation-1" },
    };
  });
  const Stub = createRoutesStub([
    {
      path: "/ioio/loans",
      Component: PickupFormHarness,
      action,
    },
  ]);

  render(<Stub initialEntries={["/ioio/loans"]} />);

  const pickupButton = screen.getByTestId("top-pickup-action");
  expect(screen.getAllByRole("button", { name: "Pick up item" })).toHaveLength(
    1
  );
  expect(pickupButton).toBeDisabled();
  expect(screen.queryByRole("button", { name: "Confirm pickup" })).toBeNull();

  fireEvent.change(
    screen.getByLabelText(
      "Scan the assigned item's QR code or enter its unit number"
    ),
    { target: { value: "http://127.0.0.1:3000/qr/vdqo0i7hk9" } }
  );

  expect(await screen.findByText("✓ Correct item")).toBeTruthy();
  expect(screen.getByText("Makey Kit #003")).toBeTruthy();
  expect(
    screen.getByLabelText(
      "Scan the assigned item's QR code or enter its unit number"
    )
  ).toHaveValue("Makey Kit #003");
  expect(pickupButton).toBeEnabled();
  fireEvent.click(pickupButton);
  fireEvent.click(pickupButton);
  await waitFor(() => {
    expect(action).toHaveBeenCalledTimes(2);
  });
  expect(submissions[1]).toEqual({
    intent: "confirm-pickup",
    value: "vdqo0i7hk9",
  });
  expect(screen.queryByRole("button", { name: "Confirm pickup" })).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Scan another unit" })
  ).toBeNull();
});

it("keeps pickup disabled for a resolved wrong unit", async () => {
  const action = vi.fn(async ({ request }: { request: Request }) => {
    const form = await request.formData();
    return {
      ok: true,
      intent: "pickup-validated",
      inputValue: form.get("verificationValue"),
      validation: {
        valid: false,
        status: "wrong-unit",
        assignedUnitLabel: "Makey Kit #003",
        scannedUnitLabel: "Makey Kit #004",
        error: "Wrong unit. This request is assigned to Makey Kit #003.",
      },
    };
  });
  const Stub = createRoutesStub([
    {
      path: "/ioio/loans",
      Component: PickupFormHarness,
      action,
    },
  ]);

  render(<Stub initialEntries={["/ioio/loans"]} />);
  fireEvent.change(
    screen.getByLabelText(
      "Scan the assigned item's QR code or enter its unit number"
    ),
    { target: { value: "#004" } }
  );

  expect(await screen.findByText("✕ Wrong item")).toBeTruthy();
  expect(screen.getByText("Expected Makey Kit #003")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Pick up item" })).toBeDisabled();
});

it("submits one validation for repeated camera frames", async () => {
  const submissions: FormData[] = [];
  const action = vi.fn(async ({ request }: { request: Request }) => {
    const form = await request.formData();
    submissions.push(form);
    return {
      ok: true,
      intent: "pickup-validated",
      inputValue: form.get("verificationValue"),
      validation: {
        valid: true,
        status: "valid",
        assignedUnitLabel: "Makey Kit #003",
      },
    };
  });
  const Stub = createRoutesStub([
    {
      path: "/ioio/loans",
      Component: PickupFormHarness,
      action,
    },
  ]);

  render(<Stub initialEntries={["/ioio/loans"]} />);
  fireEvent.click(screen.getByRole("button", { name: "Scan QR" }));
  fireEvent.click(
    screen.getByRole("button", { name: "Emit same QR 20 times" })
  );

  expect(await screen.findByText("✓ Correct item")).toBeTruthy();
  await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
  expect(submissions[0].get("verificationValue")).toBe("vdqo0i7hk9");
  expect(screen.getByRole("button", { name: "Pick up item" })).toBeEnabled();
});

it("deduplicates equivalent QR URL and path forms", async () => {
  const submissions: string[] = [];
  const action = vi.fn(async ({ request }: { request: Request }) => {
    const form = await request.formData();
    submissions.push(String(form.get("verificationValue")));
    return {
      ok: true,
      intent: "pickup-validated",
      inputValue: form.get("verificationValue"),
      validation: {
        valid: false,
        status: "wrong-unit",
        assignedUnitLabel: "Makey Kit #003",
        scannedUnitLabel: "Makey Kit #004",
        error: "This isn't the item assigned to your request.",
      },
    };
  });
  const Stub = createRoutesStub([
    {
      path: "/ioio/loans",
      Component: PickupFormHarness,
      action,
    },
  ]);

  render(<Stub initialEntries={["/ioio/loans"]} />);
  fireEvent.click(screen.getByRole("button", { name: "Scan QR" }));
  fireEvent.click(
    screen.getByRole("button", { name: "Emit equivalent QR forms" })
  );
  expect(await screen.findByText("✕ Wrong item")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Pick up item" })).toBeDisabled();
  expect(action).toHaveBeenCalledTimes(1);
  expect(submissions).toEqual(["vdqo0i7hk9"]);
});

it("deduplicates a wrong code and accepts a later different code", async () => {
  const submissions: string[] = [];
  const action = vi.fn(async ({ request }: { request: Request }) => {
    const form = await request.formData();
    const value = String(form.get("verificationValue"));
    submissions.push(value);
    const valid = value === "vdqo0i7hk9" || value === "#003";
    return {
      ok: true,
      intent: "pickup-validated",
      inputValue: value,
      validation: valid
        ? {
            valid: true,
            status: "valid",
            assignedUnitLabel: "Makey Kit #003",
          }
        : {
            valid: false,
            status: "wrong-unit",
            assignedUnitLabel: "Makey Kit #003",
            scannedUnitLabel: "Makey Kit #004",
            error: "This isn't the item assigned to your request.",
          },
    };
  });
  const Stub = createRoutesStub([
    {
      path: "/ioio/loans",
      Component: PickupFormHarness,
      action,
    },
  ]);

  render(<Stub initialEntries={["/ioio/loans"]} />);
  fireEvent.click(screen.getByRole("button", { name: "Scan QR" }));
  fireEvent.click(
    screen.getByRole("button", { name: "Emit wrong QR 20 times" })
  );
  expect(await screen.findByText("✕ Wrong item")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Pick up item" })).toBeDisabled();
  expect(action).toHaveBeenCalledTimes(1);
  expect(submissions).toEqual(["wrong-unit-004"]);

  fireEvent.click(screen.getByRole("button", { name: "Emit correct QR" }));
  expect(await screen.findByText("✓ Correct item")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Pick up item" })).toBeEnabled();
  expect(action).toHaveBeenCalledTimes(2);
  expect(submissions).toEqual(["wrong-unit-004", "vdqo0i7hk9"]);
});

it("debounces manual typing and allows a different scan after a wrong scan", async () => {
  const submissions: string[] = [];
  const action = vi.fn(async ({ request }: { request: Request }) => {
    const form = await request.formData();
    const value = String(form.get("verificationValue"));
    submissions.push(value);
    return {
      ok: true,
      intent: "pickup-validated",
      inputValue: value,
      validation:
        value === "vdqo0i7hk9" || value === "#003"
          ? {
              valid: true,
              status: "valid",
              assignedUnitLabel: "Makey Kit #003",
            }
          : {
              valid: false,
              status: "wrong-unit",
              assignedUnitLabel: "Makey Kit #003",
              scannedUnitLabel: "Makey Kit #004",
              error: "This isn't the item assigned to your request.",
            },
    };
  });
  const Stub = createRoutesStub([
    {
      path: "/ioio/loans",
      Component: PickupFormHarness,
      action,
    },
  ]);

  render(<Stub initialEntries={["/ioio/loans"]} />);
  const input = screen.getByLabelText(
    "Scan the assigned item's QR code or enter its unit number"
  );
  for (const value of ["#", "#0", "#00", "#003"]) {
    fireEvent.change(input, { target: { value } });
  }
  expect(await screen.findByText("✓ Correct item")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Pick up item" })).toBeEnabled();
  await waitFor(() => expect(action).toHaveBeenCalledTimes(1), {
    timeout: 1500,
  });
  expect(submissions).toEqual(["#003"]);

  fireEvent.change(input, {
    target: { value: "http://localhost:3000/qr/wrong-unit-004" },
  });
  expect(await screen.findByText("✕ Wrong item")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Pick up item" })).toBeDisabled();
  expect(submissions).toEqual(["#003", "wrong-unit-004"]);
  fireEvent.change(input, { target: { value: "/qr/vdqo0i7hk9" } });
  expect(await screen.findByText("✓ Correct item")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Pick up item" })).toBeEnabled();
  expect(submissions).toEqual(["#003", "wrong-unit-004", "vdqo0i7hk9"]);
});
