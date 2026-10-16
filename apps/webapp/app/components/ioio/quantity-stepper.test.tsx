import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { QuantityStepper } from "./quantity-stepper";

function BasketHarness() {
  const [quantities, setQuantities] = useState({ arduino: 1, cable: 2 });
  return (
    <>
      {Object.entries(quantities).map(([id, value]) => (
        <div key={id}>
          <QuantityStepper
            label={`quantity for ${id}`}
            value={value}
            max={id === "arduino" ? 2 : 5}
            onChange={(quantity) =>
              setQuantities((current) => ({ ...current, [id]: quantity }))
            }
          />
        </div>
      ))}
    </>
  );
}

describe("QuantityStepper", () => {
  it("keeps each basket line between one and its available quantity", () => {
    render(<BasketHarness />);

    const arduinoIncrease = screen.getByRole("button", {
      name: "Increase quantity for arduino",
    });
    const arduinoDecrease = screen.getByRole("button", {
      name: "Decrease quantity for arduino",
    });
    fireEvent.click(arduinoIncrease);
    expect(screen.getByLabelText("quantity for arduino 2")).toBeInTheDocument();
    expect(arduinoIncrease).toBeDisabled();

    fireEvent.click(arduinoDecrease);
    expect(screen.getByLabelText("quantity for arduino 1")).toBeInTheDocument();
    expect(arduinoDecrease).toBeDisabled();
    expect(screen.getByLabelText("quantity for cable 2")).toBeInTheDocument();
  });

  it("shows quantity one and disables both controls when only one is available", () => {
    render(
      <QuantityStepper
        label="Quantity for camera"
        value={1}
        max={1}
        onChange={() => undefined}
      />
    );

    expect(screen.getByLabelText("Quantity for camera 1")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Increase quantity for camera" })
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Decrease quantity for camera" })
    ).toBeDisabled();
  });
});
