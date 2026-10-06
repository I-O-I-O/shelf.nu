import type { ReactNode } from "react";
import { IOIO_OPENING_HOURS_GUIDANCE } from "~/modules/ioio-staff/preparation";

export type LabInfoOpeningDay = { day: string; hours: string };
export type LabInfoTA = { name: string; profilePicture: string | null };

export function LabInfoOperationalCard({
  title,
  children,
  showTitle = true,
}: {
  title: string;
  children: ReactNode;
  showTitle?: boolean;
}) {
  return (
    <section
      aria-label={title}
      className="mx-auto w-full max-w-5xl rounded-2xl border border-gray-200 bg-white p-5 text-left shadow-sm sm:p-6"
    >
      {showTitle ? (
        <h2 className="text-lg font-semibold text-gray-900">{title}</h2>
      ) : null}
      <div className={showTitle ? "mt-3" : ""}>{children}</div>
    </section>
  );
}

export function LabInfoOpeningHoursContent({
  days,
  pickupLocation,
}: {
  days: LabInfoOpeningDay[];
  pickupLocation: string | null;
}) {
  return (
    <>
      {days.length ? (
        <div className="divide-y divide-gray-100 rounded-lg border border-gray-100">
          {days.map(({ day, hours }) => (
            <div
              key={day}
              className="flex justify-between gap-4 px-3 py-2 text-sm"
            >
              <span className="font-medium text-gray-900">{day}</span>
              <span className="text-gray-600">{hours}</span>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-gray-600">
          Opening hours have not been published yet.
        </p>
      )}
      <p className="mt-4 text-sm leading-6 text-gray-600">
        {IOIO_OPENING_HOURS_GUIDANCE}
      </p>
      {pickupLocation ? (
        <div className="mt-4 rounded-lg bg-gray-50 p-3 text-sm text-gray-700">
          <span className="font-semibold text-gray-900">Pickup Zone</span>
          <span className="ml-2">{pickupLocation}</span>
        </div>
      ) : null}
    </>
  );
}

export function LabInfoTAsContent({ tas }: { tas: LabInfoTA[] }) {
  return tas.length ? (
    <div className="grid gap-2 sm:grid-cols-2">
      {tas.map((ta, index) => (
        <div
          key={`${ta.name}-${index}`}
          className="flex items-center gap-3 rounded-lg border border-gray-100 p-3"
        >
          {ta.profilePicture ? (
            <img
              src={ta.profilePicture}
              alt=""
              className="size-9 rounded-full object-cover"
            />
          ) : (
            <div className="flex size-9 items-center justify-center rounded-full bg-red-100 text-sm font-semibold text-red-800">
              {(ta.name || "T").slice(0, 1).toUpperCase()}
            </div>
          )}
          <span className="text-sm font-medium text-gray-900">
            {ta.name || "Lab TA"}
          </span>
        </div>
      ))}
    </div>
  ) : (
    <p className="text-sm text-gray-600">
      Lab TA information has not been published yet.
    </p>
  );
}
