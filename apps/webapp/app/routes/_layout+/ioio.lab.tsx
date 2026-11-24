import { useState } from "react";
import { OrganizationRoles } from "@prisma/client";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { data, Link, useLoaderData } from "react-router";
import { ErrorContent } from "~/components/errors";
import { LabInfoContentSection } from "~/components/ioio-lab-information/content-section";
import {
  LabInfoOperationalCard,
  LabInfoOpeningHoursContent,
  LabInfoTAsContent,
} from "~/components/ioio-lab-information/operational-content";
import { db } from "~/database/db.server";
import { getLabInformation } from "~/modules/ioio-lab-information/service.server";
import { getPickupLocationDisplay } from "~/modules/ioio-staff/pickup-zone.server";
import { requireStudentRead } from "~/modules/ioio-student/route.server";
import { getWorkingHoursForOrganization } from "~/modules/working-hours/service.server";
import type {
  DaySchedule,
  WeeklyScheduleJson,
} from "~/modules/working-hours/types";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import { ShelfError, makeShelfError } from "~/utils/error";
import { error, payload } from "~/utils/http.server";

const weekdays = [
  [1, "Monday"],
  [2, "Tuesday"],
  [3, "Wednesday"],
  [4, "Thursday"],
  [5, "Friday"],
  [6, "Saturday"],
  [0, "Sunday"],
] as const;

function formatOpeningHours(
  enabled: boolean,
  schedule: unknown
): Array<{ day: string; hours: string }> {
  if (!enabled || !schedule || typeof schedule !== "object") return [];
  const weeklySchedule = schedule as WeeklyScheduleJson;
  return weekdays.flatMap(([dayNumber, day]) => {
    const daySchedule = weeklySchedule[String(dayNumber)] as
      | DaySchedule
      | undefined;
    if (!daySchedule?.isOpen) return [];
    const hours =
      daySchedule.openTime && daySchedule.closeTime
        ? `${daySchedule.openTime} - ${daySchedule.closeTime}`
        : "Open hours not published";
    return [{ day, hours }];
  });
}

export async function loader({ context, request }: LoaderFunctionArgs) {
  const { userId } = context.getSession();
  try {
    const auth = await requireStudentRead({ context, request });
    if (auth.role !== OrganizationRoles.SELF_SERVICE) {
      throw new ShelfError({
        cause: null,
        title: "Student page required",
        message: "This information page is available to Student accounts.",
        status: 403,
        label: "Settings",
        shouldBeCaptured: false,
      });
    }

    const [information, workingHours, pickupZone] = await Promise.all([
      getLabInformation(auth.organizationId),
      getWorkingHoursForOrganization(auth.organizationId),
      db.location.findFirst({
        where: {
          organizationId: auth.organizationId,
          name: "Pickup Zone",
        },
        orderBy: { createdAt: "asc" },
        select: { id: true },
      }),
    ]);

    return payload({
      information,
      openingHours: {
        published: workingHours.enabled,
        days: formatOpeningHours(
          workingHours.enabled,
          workingHours.weeklySchedule
        ),
      },
      pickupLocation: pickupZone
        ? await getPickupLocationDisplay({
            organizationId: auth.organizationId,
            locationId: pickupZone.id,
          })
        : null,
    });
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    throw data(error(reason), { status: reason.status });
  }
}

export const meta: MetaFunction<typeof loader> = () => [
  { title: appendToMetaTitle("IOIO Lab") },
];

export const handle = { breadcrumb: () => "IOIO Lab" };

export default function StudentLabInformationPage() {
  const { information, openingHours, pickupLocation } =
    useLoaderData<typeof loader>();
  const [activeSection, setActiveSection] = useState("about");
  const active = information.sections.find(
    (section) => section.key === activeSection
  );

  return (
    <main className="min-h-full bg-gray-50 px-4 py-6 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-7xl">
        <div className="rounded-2xl bg-red-800 px-5 py-6 text-center text-white shadow-sm sm:px-8">
          <p className="text-sm font-semibold uppercase tracking-[0.18em] text-white">
            IOIO Lab
          </p>
          <h1 className="mt-2 text-3xl font-bold tracking-tight text-white">
            Your guide to the Lab
          </h1>
          <p className="mx-auto mt-2 max-w-2xl text-sm leading-6 text-white/90">
            Find out how borrowing, opening hours, returns, and help work at
            IOIO Lab.
          </p>
        </div>

        <nav
          aria-label="IOIO Lab information"
          className="mt-4 flex flex-wrap justify-center gap-2 rounded-xl border border-gray-200 bg-white p-3"
        >
          {information.sections.map((section) => (
            <button
              key={section.key}
              type="button"
              aria-pressed={activeSection === section.key}
              onClick={() => setActiveSection(section.key)}
              className={`rounded-lg px-3 py-2 text-sm font-medium transition focus:outline-none focus:ring-2 focus:ring-red-700 focus:ring-offset-2 ${
                activeSection === section.key
                  ? "bg-red-700 text-white"
                  : "text-gray-700 hover:bg-red-50 hover:text-red-800"
              }`}
            >
              {section.title}
            </button>
          ))}
        </nav>

        <div className="mt-4">
          {active?.kind === "opening-hours" ? (
            <LabInfoOperationalCard title={active.title}>
              <LabInfoOpeningHoursContent
                days={openingHours.published ? openingHours.days : []}
                pickupLocation={pickupLocation?.label ?? null}
              />
            </LabInfoOperationalCard>
          ) : null}
          {active?.kind === "lab-tas" ? (
            <LabInfoOperationalCard title={active.title}>
              <LabInfoTAsContent tas={information.tas} />
            </LabInfoOperationalCard>
          ) : null}
          {active && !active.kind ? (
            <div className="space-y-4">
              <LabInfoContentSection
                title={active.title}
                text={active.text}
                images={active.images}
              />
              {active.key === "help" ? (
                <div className="mx-auto w-full max-w-5xl">
                  <div>
                    <Link
                      to="/ioio/report"
                      className="inline-flex rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50"
                    >
                      Report a problem
                    </Link>
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </main>
  );
}

export const ErrorBoundary = () => <ErrorContent />;
