import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { ReservationQuantityControl } from "./reservation-quantity-control";

function QuantityHarness() {
  const [quantity, setQuantity] = useState("1");
  return (
    <>
      <label htmlFor="reservation-quantity">Quantity</label>
      <ReservationQuantityControl value={quantity} onChange={setQuantity} />
      <output>{quantity}</output>
    </>
  );
}

describe("ReservationQuantityControl", () => {
  it("allows clearing and replacing the number without concatenating", () => {
    render(<QuantityHarness />);
    const input = screen.getByRole("spinbutton", { name: "Quantity" });

    fireEvent.change(input, { target: { value: "" } });
    expect((input as HTMLInputElement).value).toBe("");

    fireEvent.change(input, { target: { value: "5" } });
    expect((input as HTMLInputElement).value).toBe("5");
    expect(screen.getByText("5").tagName).toBe("OUTPUT");
  });

  it("keeps the plus/minus controls working", () => {
    render(<QuantityHarness />);
    fireEvent.click(screen.getByRole("button", { name: "Increase quantity" }));
    expect(screen.getByText("2").tagName).toBe("OUTPUT");
    fireEvent.click(screen.getByRole("button", { name: "Decrease quantity" }));
    expect(screen.getByText("1").tagName).toBe("OUTPUT");
  });
});
