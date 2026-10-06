export function ReservationQuantityControl({
  value,
  onChange,
  max = 1000,
}: {
  value: string;
  onChange: (value: string) => void;
  max?: number;
}) {
  const quantity = Number(value);
  const valid = Number.isInteger(quantity) && quantity >= 1 && quantity <= max;

  function normalize() {
    if (!value.trim() || !Number.isFinite(quantity)) {
      onChange("1");
      return;
    }
    onChange(String(Math.min(max, Math.max(1, Math.trunc(quantity)))));
  }

  return (
    <div>
      <div className="inline-flex items-center gap-2">
        <button
          type="button"
          aria-label="Decrease quantity"
          disabled={valid && quantity <= 1}
          onClick={() =>
            onChange(String(Math.max(1, (valid ? quantity : 2) - 1)))
          }
          className="size-10 rounded-lg border border-gray-300 text-lg font-semibold text-gray-700 disabled:opacity-50"
        >
          −
        </button>
        <input
          id="reservation-quantity"
          name="quantity"
          type="number"
          min={1}
          max={max}
          step={1}
          value={value}
          aria-invalid={!valid}
          aria-describedby={!valid ? "reservation-quantity-error" : undefined}
          onChange={(event) => onChange(event.target.value)}
          onBlur={normalize}
          className="min-h-10 w-20 rounded-lg border border-gray-300 px-2 text-center font-normal"
        />
        <button
          type="button"
          aria-label="Increase quantity"
          disabled={valid && quantity >= max}
          onClick={() => onChange(String((valid ? quantity : 0) + 1))}
          className="size-10 rounded-lg border border-gray-300 text-lg font-semibold text-gray-700 disabled:opacity-50"
        >
          +
        </button>
      </div>
      {!valid ? (
        <p
          id="reservation-quantity-error"
          className="mt-1 text-sm text-red-700"
          role="alert"
        >
          Enter a whole number from 1 to {max.toLocaleString()}.
        </p>
      ) : null}
    </div>
  );
}
