import { useFetcher } from "react-router";
import { Button } from "~/components/shared/button";
import { Card } from "~/components/shared/card";

type PhysicalUnitAvailabilityResponse = {
  success?: boolean;
  error?: { message?: string };
};

function formatUnitStatus(status: string) {
  return status
    .toLocaleLowerCase()
    .replaceAll("_", " ")
    .replace(/^\w/u, (letter) => letter.toLocaleUpperCase());
}

export function IoioPhysicalUnitEditForm({
  id,
  title,
  status,
  availableToBook,
  availabilityBlock,
  qrId,
}: {
  id: string;
  title: string;
  status: string;
  availableToBook: boolean;
  availabilityBlock: string | null;
  qrId?: string;
}) {
  const fetcher = useFetcher<PhysicalUnitAvailabilityResponse>();
  const busy = fetcher.state !== "idle";
  const canChangeAvailability = !availabilityBlock && status === "AVAILABLE";
  const availabilityLabel =
    status !== "AVAILABLE"
      ? formatUnitStatus(status)
      : availabilityBlock
      ? "Unavailable"
      : availableToBook
      ? "Available"
      : "Unavailable";

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6 lg:px-8">
      <Card className="w-full p-5 sm:p-7">
        <header className="border-b border-gray-200 pb-5">
          <p className="text-xs font-black uppercase tracking-[0.16em] text-red-700">
            Physical unit
          </p>
          <h1 className="mt-1 text-2xl font-black text-gray-950">{title}</h1>
        </header>

        <div className="grid gap-4 py-5 sm:grid-cols-2">
          <section
            aria-labelledby="unit-availability-heading"
            className="rounded-xl border border-gray-200 bg-gray-50 p-4"
          >
            <h2
              id="unit-availability-heading"
              className="text-xs font-bold uppercase tracking-wide text-gray-500"
            >
              Availability
            </h2>
            <p className="mt-1 font-semibold text-gray-900">
              {availabilityLabel}
            </p>
            {availabilityBlock ? (
              <p className="mt-2 text-sm text-gray-600">{availabilityBlock}</p>
            ) : null}
            <fetcher.Form method="post" action="." className="mt-3">
              <input
                type="hidden"
                name="intent"
                value="physical-unit-availability"
              />
              <input
                type="hidden"
                name="availabilityAction"
                value={availableToBook ? "unavailable" : "available"}
              />
              <Button
                type="submit"
                variant="secondary"
                disabled={busy || !canChangeAvailability}
              >
                {availabilityBlock
                  ? "Availability locked"
                  : busy
                  ? "Saving…"
                  : availableToBook
                  ? "Mark unavailable"
                  : "Mark available"}
              </Button>
            </fetcher.Form>
          </section>

          <section
            aria-labelledby="unit-qr-heading"
            className="rounded-xl border border-gray-200 bg-gray-50 p-4"
          >
            <h2
              id="unit-qr-heading"
              className="text-xs font-bold uppercase tracking-wide text-gray-500"
            >
              QR label
            </h2>
            <p className="mt-1 font-semibold text-gray-900">
              {qrId ? "Assigned" : "Not assigned"}
            </p>
            <Button
              to={`/labels?assetId=${encodeURIComponent(id)}`}
              variant="link"
              className="mt-3 !p-0 text-sm"
            >
              Print unit label
            </Button>
          </section>
        </div>

        {fetcher.data?.error?.message ? (
          <p role="alert" className="text-sm text-red-700">
            {fetcher.data.error.message}
          </p>
        ) : null}
      </Card>
    </div>
  );
}
