import { useState } from "react";
import { OrganizationRoles } from "@prisma/client";
import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import {
  data,
  Form,
  redirect,
  useActionData,
  useLoaderData,
} from "react-router";
import { LabInfoContentSection } from "~/components/ioio-lab-information/content-section";
import {
  LabInfoOperationalCard,
  LabInfoOpeningHoursContent,
  LabInfoTAsContent,
} from "~/components/ioio-lab-information/operational-content";
import { Button } from "~/components/shared/button";
import { db } from "~/database/db.server";
import { getLabInformation } from "~/modules/ioio-lab-information/service.server";
import { getPickupLocationDisplay } from "~/modules/ioio-staff/pickup-zone.server";
import { completeStudentLabIntroduction } from "~/modules/ioio-student/lab-introduction.server";
import { requireStudentRead } from "~/modules/ioio-student/route.server";
import { getWorkingHoursForOrganization } from "~/modules/working-hours/service.server";
import type {
  DaySchedule,
  WeeklyScheduleJson,
} from "~/modules/working-hours/types";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import { makeShelfError, ShelfError } from "~/utils/error";
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

async function requireStudentIntroductionUser(args: {
  context: ActionFunctionArgs["context"];
  request: Request;
}) {
  const auth = await requireStudentRead(args);
  if (auth.role !== OrganizationRoles.SELF_SERVICE) {
    throw new ShelfError({
      cause: null,
      title: "Student page required",
      message: "This introduction is available to Student accounts.",
      status: 403,
      label: "Permission",
      shouldBeCaptured: false,
    });
  }
  return auth;
}

export async function loader({ context, request }: LoaderFunctionArgs) {
  const { userId } = context.getSession();
  try {
    const auth = await requireStudentIntroductionUser({ context, request });
    const membership = await db.userOrganization.findUnique({
      where: {
        userId_organizationId: {
          userId: auth.userId,
          organizationId: auth.organizationId,
        },
      },
      select: { labIntroductionCompleted: true },
    });
    if (!membership || membership.labIntroductionCompleted) {
      return redirect("/ioio");
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
      openingHours: formatOpeningHours(
        workingHours.enabled,
        workingHours.weeklySchedule
      ),
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

export async function action({ context, request }: ActionFunctionArgs) {
  const { userId } = context.getSession();
  try {
    const auth = await requireStudentIntroductionUser({ context, request });
    const formData = await request.formData();
    if (formData.get("intent") !== "complete-introduction") {
      throw new Error("Unsupported Lab introduction action.");
    }
    if (formData.get("rulesAcknowledged") !== "true") {
      return data(
        { errorMessage: "Please confirm that you have read the Lab rules." },
        { status: 400 }
      );
    }

    const completed = await completeStudentLabIntroduction({
      organizationId: auth.organizationId,
      userId: auth.userId,
    });
    if (!completed) {
      const membership = await db.userOrganization.findUnique({
        where: {
          userId_organizationId: {
            userId: auth.userId,
            organizationId: auth.organizationId,
          },
        },
        select: { labIntroductionCompleted: true },
      });
      if (!membership?.labIntroductionCompleted) {
        throw new Error("Your Lab introduction could not be completed.");
      }
    }
    return redirect("/ioio");
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    return data(error(reason), { status: reason.status });
  }
}

export const meta: MetaFunction<typeof loader> = () => [
  { title: appendToMetaTitle("Welcome to IOIO Lab") },
];

export default function StudentLabIntroductionPage() {
  const { information, openingHours, pickupLocation } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const [step, setStep] = useState(0);
  const [rulesAcknowledged, setRulesAcknowledged] = useState(false);
  const finalStep = information.sections.length + 1;
  const section = information.sections[step - 1];
  const errorMessage =
    actionData && "errorMessage" in actionData ? actionData.errorMessage : null;
  const actionError =
    actionData && "error" in actionData && actionData.error
      ? actionData.error.message
      : null;

  return (
    <main className="min-h-full bg-gray-50 px-4 py-6 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-5xl">
        <header className="rounded-2xl bg-red-800 p-5 text-white shadow-sm sm:px-7">
          <p className="text-sm font-semibold uppercase tracking-[0.16em] text-white/90">
            IOIO Lab orientation
          </p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight sm:text-3xl">
            {step === 0
              ? "Welcome to IOIO Lab"
              : step === finalStep
              ? "You're ready to use IOIO Lab"
              : section?.title ?? ""}
          </h1>
          {step > 0 && step < finalStep ? (
            <div className="mt-4 flex items-center gap-3">
              <span className="shrink-0 text-sm text-white/90">
                {step} of {information.sections.length}
              </span>
              <div
                className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/25"
                role="progressbar"
                aria-valuemin={1}
                aria-valuemax={information.sections.length}
                aria-valuenow={step}
                aria-label="Lab introduction progress"
              >
                <div
                  className="h-full rounded-full bg-white transition-[width]"
                  style={{
                    width: `${(step / information.sections.length) * 100}%`,
                  }}
                />
              </div>
            </div>
          ) : null}
        </header>

        <div className="mt-4 min-h-72">
          {step === 0 ? (
            <section className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm sm:p-8">
              <p className="max-w-2xl text-base leading-7 text-gray-700">
                Take a quick guided look at the information the TAs maintain for
                IOIO Lab. You can revisit it anytime in About IOIO Lab.
              </p>
              <p className="mt-3 text-sm text-gray-500">
                This is a one-time introduction. It is separate from annual
                borrowing approval.
              </p>
            </section>
          ) : null}

          {section?.kind === "opening-hours" ? (
            <LabInfoOperationalCard title={section.title} showTitle={false}>
              <LabInfoOpeningHoursContent
                days={openingHours}
                pickupLocation={pickupLocation?.label ?? null}
              />
            </LabInfoOperationalCard>
          ) : null}
          {section?.kind === "lab-tas" ? (
            <LabInfoOperationalCard title={section.title} showTitle={false}>
              <LabInfoTAsContent tas={information.tas} />
            </LabInfoOperationalCard>
          ) : null}
          {section && !section.kind ? (
            <LabInfoContentSection
              title={section.title}
              text={section.text}
              images={section.images}
              showTitle={false}
            />
          ) : null}

          {section?.key === "rules" ? (
            <label className="mt-4 flex items-start gap-3 rounded-lg border border-gray-200 bg-white p-4 text-sm text-gray-800">
              <input
                type="checkbox"
                checked={rulesAcknowledged}
                onChange={(event) =>
                  setRulesAcknowledged(event.currentTarget.checked)
                }
                className="mt-0.5 size-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
              />
              <span>I have read the IOIO Lab rules.</span>
            </label>
          ) : null}

          {step === finalStep ? (
            <section className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm sm:p-8">
              <p className="text-base leading-7 text-gray-700">
                You can find this information again anytime in IOIO Lab → Lab
                Info.
              </p>
              {errorMessage || actionError ? (
                <p
                  className="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-800"
                  role="alert"
                >
                  {errorMessage ?? actionError}
                </p>
              ) : null}
            </section>
          ) : null}
        </div>

        <footer className="mt-4 flex items-center justify-between gap-3">
          <Button
            type="button"
            variant="secondary"
            onClick={() => setStep((current) => Math.max(0, current - 1))}
            disabled={step === 0}
          >
            Back
          </Button>
          {step < finalStep ? (
            <Button
              type="button"
              onClick={() =>
                setStep((current) => Math.min(finalStep, current + 1))
              }
              disabled={section?.key === "rules" && !rulesAcknowledged}
            >
              {step === finalStep - 1 ? "Finish" : "Continue"}
            </Button>
          ) : (
            <Form method="post">
              <input
                type="hidden"
                name="intent"
                value="complete-introduction"
              />
              <input
                type="hidden"
                name="rulesAcknowledged"
                value={String(rulesAcknowledged)}
              />
              <Button type="submit">Go to IOIO Lab</Button>
            </Form>
          )}
        </footer>
      </div>
    </main>
  );
}
