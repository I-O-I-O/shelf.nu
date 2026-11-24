import { useEffect, useState } from "react";
import { CheckCircle2 } from "lucide-react";
import { useNavigate } from "react-router";

export type BorrowCompletionItem = {
  itemId: string;
  title: string;
  quantity: number;
  dueDate?: string;
  requiresStaffPreparation?: boolean;
};

function formatDueDate(value: string) {
  const date = /^\d{4}-\d{2}-\d{2}$/u.test(value)
    ? new Date(`${value}T00:00:00.000Z`)
    : new Date(value);

  if (!Number.isFinite(date.getTime())) {
    return "Date unavailable";
  }

  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

export function BorrowSuccess({
  items,
  dashboardPath,
  completionPath = dashboardPath,
  completionLabel = "Go to Dashboard",
}: {
  items: BorrowCompletionItem[];
  dashboardPath: string;
  completionPath?: string;
  completionLabel?: string;
}) {
  const navigate = useNavigate();
  const [secondsLeft, setSecondsLeft] = useState(5);
  const waitingForPreparation = items.some(
    (item) => item.requiresStaffPreparation
  );

  useEffect(() => {
    const countdown = window.setInterval(() => {
      setSecondsLeft((current) => Math.max(0, current - 1));
    }, 1000);
    const redirect = window.setTimeout(() => {
      void navigate(completionPath);
    }, 5000);

    return () => {
      window.clearInterval(countdown);
      window.clearTimeout(redirect);
    };
  }, [completionPath, navigate]);

  return (
    <section
      role="status"
      className="mx-auto max-w-2xl rounded-2xl border border-green-200 bg-green-50 p-6 shadow-sm"
    >
      <div className="flex items-start gap-3">
        <CheckCircle2
          aria-hidden="true"
          className="mt-0.5 size-6 shrink-0 text-green-700"
        />
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-black tracking-tight text-green-950">
            {waitingForPreparation
              ? "Borrowing confirmed"
              : "Borrowing complete"}
          </h1>
          <p className="mt-1 text-sm font-semibold text-green-900">
            {items.length === 1
              ? "You successfully borrowed:"
              : `You successfully borrowed ${items.length} items.`}
          </p>
          <ul className="mt-4 space-y-2 text-sm text-green-950">
            {items.map((item) => (
              <li
                key={item.itemId}
                className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 rounded-xl border border-green-200 bg-white/70 px-3 py-2"
              >
                <span className="font-bold">
                  {item.title}
                  {item.quantity > 1 ? ` x${item.quantity}` : ""}
                  {item.requiresStaffPreparation ? (
                    <span className="mt-1 block text-xs font-semibold text-amber-800">
                      Waiting for preparation
                    </span>
                  ) : null}
                </span>
                {item.dueDate ? (
                  <span className="text-xs font-semibold text-green-800">
                    Due {formatDueDate(item.dueDate)}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
          <div className="mt-5 flex flex-wrap items-center gap-3">
            <p className="text-sm font-semibold text-green-900">
              Returning to {waitingForPreparation ? "My Loans" : "Dashboard"} in{" "}
              {secondsLeft} seconds...
            </p>
            <button
              type="button"
              onClick={() => void navigate(completionPath)}
              className="rounded-xl bg-green-700 px-4 py-2 text-sm font-bold text-white hover:bg-green-800 focus:outline-none focus:ring-2 focus:ring-green-700 focus:ring-offset-2"
            >
              {completionLabel}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
