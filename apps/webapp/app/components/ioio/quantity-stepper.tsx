export function QuantityStepper({
  value,
  max,
  onChange,
  label,
  disabled = false,
}: {
  value: number;
  max: number;
  onChange: (quantity: number) => void;
  label: string;
  disabled?: boolean;
}) {
  const safeMax = Math.max(1, Math.trunc(max));
  const safeValue = Math.min(safeMax, Math.max(1, Math.trunc(value) || 1));

  return (
    <div className="inline-flex items-center gap-2">
      <button
        type="button"
        aria-label={`Decrease ${label.toLocaleLowerCase()}`}
        disabled={disabled || safeValue <= 1}
        onClick={() => onChange(Math.max(1, safeValue - 1))}
        className="inline-flex size-9 items-center justify-center rounded-lg border border-gray-300 text-lg font-semibold text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
      >
        −
      </button>
      <span
        aria-label={`${label} ${safeValue}`}
        className="min-w-6 text-center font-semibold tabular-nums text-gray-900"
      >
        {safeValue}
      </span>
      <button
        type="button"
        aria-label={`Increase ${label.toLocaleLowerCase()}`}
        disabled={disabled || safeValue >= safeMax}
        onClick={() => onChange(Math.min(safeMax, safeValue + 1))}
        className="inline-flex size-9 items-center justify-center rounded-lg border border-gray-300 text-lg font-semibold text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
      >
        +
      </button>
    </div>
  );
}
