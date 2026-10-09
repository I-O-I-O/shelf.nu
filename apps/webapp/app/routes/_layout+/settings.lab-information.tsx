import { useEffect, useState } from "react";
import { OrganizationType } from "@prisma/client";
import { MoreHorizontal } from "lucide-react";
import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import {
  data,
  Form,
  useActionData,
  useLoaderData,
  useLocation,
} from "react-router";
import { z } from "zod";
import { ErrorContent } from "~/components/errors";
import { LabInfoSectionEditor } from "~/components/ioio-lab-information/section-editor";
import { Button } from "~/components/shared/button";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "~/components/shared/modal";
import { Overrides } from "~/components/working-hours/overrides/overrides";
import { EnableWorkingHoursForm } from "~/components/working-hours/toggle-working-hours-form";
import { WeeklyScheduleForm } from "~/components/working-hours/weekly-schedule-form";
import { BUILT_IN_LAB_INFO_SECTIONS } from "~/modules/ioio-lab-information/sections.shared";
import {
  addLabTA,
  createCustomLabInfoSection,
  createLabInfoImage,
  deleteCustomLabInfoSection,
  getStaffLabInformation,
  markLabTAsReviewed,
  moveLabInfoImage,
  removeLabTA,
  removeLabInfoImage,
  reorderLabInfoSections,
  replaceLabInfoImage,
  updateCustomLabInfoSection,
  updateLabInfoImage,
  updateLabInfoSectionImages,
  updateLabInformationField,
} from "~/modules/ioio-lab-information/service.server";
import { requireIoioStaffAccess } from "~/modules/ioio-staff/access.server";
import {
  createWorkingHoursOverride,
  deleteWorkingHoursOverride,
  getWorkingHoursForOrganization,
  toggleWorkingHours,
  updateWorkingHoursSchedule,
} from "~/modules/working-hours/service.server";
import type { WeeklyScheduleJson } from "~/modules/working-hours/types";
import { parseWeeklyScheduleFromFormData } from "~/modules/working-hours/utils";
import {
  CreateOverrideFormSchema,
  WeeklyScheduleSchema,
  WorkingHoursToggleSchema,
} from "~/modules/working-hours/zod-utils";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import { ASSET_MAX_IMAGE_UPLOAD_SIZE, PUBLIC_BUCKET } from "~/utils/constants";
import { sendNotification } from "~/utils/emitter/send-notification.server";
import { makeShelfError, ShelfError } from "~/utils/error";
import { error, parseData, payload } from "~/utils/http.server";
import { Logger } from "~/utils/logger";
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.data";
import { requirePermission } from "~/utils/roles.server";
import {
  getFileUploadPath,
  parseFileFormData,
  removeStorageImageObject,
} from "~/utils/storage.server";

const SaveContentSchema = z.object({
  sectionKey: z.enum(["about", "borrowing", "rules", "returns", "help"]),
  value: z.string().max(5000),
});

const CustomSectionSchema = z.object({
  sectionKey: z.string().min(1).max(80),
  title: z.string().trim().min(1).max(120),
  value: z.string().max(5000),
});

const AddSectionSchema = z.object({
  title: z.string().trim().min(1).max(120),
  value: z.string().max(5000),
});

const ImageDetailsSchema = z.object({
  sectionKey: z.string().min(1).max(80),
  imageId: z.string().min(1),
  caption: z.string().max(300),
  altText: z.string().max(300),
});

const ImageSectionSchema = z.object({
  sectionKey: z.string().min(1).max(80),
  images: z
    .array(
      z.object({
        id: z.string().min(1),
        caption: z.string().max(300),
        altText: z.string().max(300),
      })
    )
    .max(8),
});

export async function loader({ context, request }: LoaderFunctionArgs) {
  const { userId } = context.getSession();
  try {
    const { organizationId } = await requireIoioStaffAccess({
      context,
      request,
    });
    let canManageWorkingHours = true;
    try {
      await requireWorkingHoursPermission({ userId, request, organizationId });
    } catch (cause) {
      if (!(cause instanceof ShelfError) || cause.status !== 403) {
        throw cause;
      }
      canManageWorkingHours = false;
    }

    const [information, workingHours] = await Promise.all([
      getStaffLabInformation(organizationId),
      getWorkingHoursForOrganization(organizationId),
    ]);
    return payload({ ...information, workingHours, canManageWorkingHours });
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    throw data(error(reason), { status: reason.status });
  }
}

export async function action({ context, request }: ActionFunctionArgs) {
  const { userId } = context.getSession();
  try {
    const { organizationId } = await requireIoioStaffAccess({
      context,
      request,
    });
    const isMultipart = request.headers
      .get("content-type")
      ?.includes("multipart/form-data");
    const uploadPath = isMultipart
      ? getFileUploadPath({
          organizationId,
          type: "lab-info",
          typeId: "sections",
        })
      : null;
    const formData = isMultipart
      ? await parseFileFormData({
          request,
          newFileName: uploadPath!,
          bucketName: PUBLIC_BUCKET,
          resizeOptions: { width: 1600, withoutEnlargement: true },
          maxFileSize: ASSET_MAX_IMAGE_UPLOAD_SIZE,
        })
      : await request.formData();
    const intent = String(formData.get("intent") ?? "");

    if (intent === "save-content") {
      const sectionKey = String(formData.get("sectionKey") ?? "");
      if (sectionKey.startsWith("custom_")) {
        const values = CustomSectionSchema.parse({
          sectionKey,
          title: String(formData.get("title") ?? ""),
          value: String(formData.get("value") ?? ""),
        });
        await updateCustomLabInfoSection({
          organizationId,
          key: values.sectionKey,
          title: values.title,
          content: values.value,
        });
        return payload({ success: true, message: "Section saved." });
      } else {
        const values = SaveContentSchema.parse({
          sectionKey,
          value: String(formData.get("value") ?? ""),
        });
        const definition = BUILT_IN_LAB_INFO_SECTIONS.find(
          (section) => section.key === values.sectionKey
        );
        if (!definition || !("field" in definition)) {
          throw new Error("This Lab Info section cannot be edited as text.");
        }
        const field = definition.field;
        const value = values.value;
        await updateLabInformationField({ organizationId, field, value });
        return payload({
          success: true,
          message: `${fieldLabels[field]} saved.`,
        });
      }
    }

    if (intent === "add-section") {
      const values = AddSectionSchema.parse({
        title: String(formData.get("title") ?? ""),
        value: String(formData.get("value") ?? ""),
      });
      const section = await createCustomLabInfoSection({
        organizationId,
        title: values.title,
        content: values.value,
      });
      return payload({
        success: true,
        message: "Section added.",
        activeSectionKey: section.key,
      });
    }

    if (intent === "reorder-sections") {
      const orderedKeys = formData.getAll("sectionKey").map(String);
      await reorderLabInfoSections({ organizationId, orderedKeys });
      return payload({ success: true, message: "Section order saved." });
    }

    if (intent === "delete-section") {
      const sectionKey = String(formData.get("sectionKey") ?? "");
      await deleteCustomLabInfoSection({ organizationId, key: sectionKey });
      return payload({
        success: true,
        message: "Section deleted.",
        activeSectionKey: "about",
      });
    }

    if (intent === "add-image" || intent === "replace-image") {
      const sectionKey = String(formData.get("sectionKey") ?? "");
      const uploadedPath = formData.get("image");
      if (typeof uploadedPath !== "string" || !uploadedPath) {
        throw new Error("Choose a valid image file first.");
      }
      try {
        if (intent === "add-image") {
          await createLabInfoImage({
            organizationId,
            sectionKey,
            storagePath: uploadedPath,
            caption: String(formData.get("caption") ?? ""),
            altText: String(formData.get("altText") ?? ""),
          });
        } else {
          await replaceLabInfoImage({
            organizationId,
            sectionKey,
            imageId: String(formData.get("imageId") ?? ""),
            storagePath: uploadedPath,
          });
        }
      } catch (cause) {
        try {
          await removeStorageImageObject({
            bucketName: PUBLIC_BUCKET,
            objectPath: uploadedPath,
          });
        } catch (cleanupError) {
          Logger.dev("[IOIO LAB INFO] Failed to clean up an unused upload", {
            message:
              cleanupError instanceof Error
                ? cleanupError.message
                : String(cleanupError),
          });
        }
        throw cause;
      }
      return payload({ success: true, message: "Image saved." });
    }

    if (intent === "update-image") {
      const values = ImageDetailsSchema.parse({
        sectionKey: String(formData.get("sectionKey") ?? ""),
        imageId: String(formData.get("imageId") ?? ""),
        caption: String(formData.get("caption") ?? ""),
        altText: String(formData.get("altText") ?? ""),
      });
      await updateLabInfoImage({
        organizationId,
        sectionKey: values.sectionKey,
        imageId: values.imageId,
        caption: values.caption,
        altText: values.altText,
      });
      return payload({ success: true, message: "Image details saved." });
    }

    if (intent === "save-images") {
      const rawImages = String(formData.get("images") ?? "");
      const values = ImageSectionSchema.parse({
        sectionKey: String(formData.get("sectionKey") ?? ""),
        images: JSON.parse(rawImages),
      });
      await updateLabInfoSectionImages({
        organizationId,
        sectionKey: values.sectionKey,
        images: values.images,
      });
      return payload({ success: true, message: "Image changes saved." });
    }

    if (intent === "remove-image") {
      await removeLabInfoImage({
        organizationId,
        sectionKey: String(formData.get("sectionKey") ?? ""),
        imageId: String(formData.get("imageId") ?? ""),
      });
      return payload({ success: true, message: "Image removed." });
    }

    if (intent === "move-image") {
      const direction = String(formData.get("direction") ?? "");
      if (direction !== "up" && direction !== "down") {
        throw new Error("Choose a valid image order change.");
      }
      await moveLabInfoImage({
        organizationId,
        sectionKey: String(formData.get("sectionKey") ?? ""),
        imageId: String(formData.get("imageId") ?? ""),
        direction,
      });
      return payload({ success: true, message: "Image order saved." });
    }

    if (
      ["toggle", "updateSchedule", "createOverride", "deleteOverride"].includes(
        intent
      )
    ) {
      await requireWorkingHoursPermission({ userId, request, organizationId });
      switch (intent) {
        case "toggle": {
          const { enableWorkingHours } = parseData(
            formData,
            WorkingHoursToggleSchema
          );
          await toggleWorkingHours({
            organizationId,
            enabled: enableWorkingHours,
          });
          sendNotification({
            title: "Opening hours updated",
            message: "The IOIO Lab opening-hours setting was updated.",
            icon: { name: "success", variant: "success" },
            senderId: userId,
          });
          return data(payload({ success: true }), { status: 200 });
        }
        case "updateSchedule": {
          const weeklySchedule = parseWeeklyScheduleFromFormData(formData);
          const validation = WeeklyScheduleSchema.safeParse(weeklySchedule);
          if (!validation.success) {
            throw new ShelfError({
              cause: validation.error,
              title: "Invalid schedule",
              message: "Please check the opening-hours schedule for errors.",
              label: "Opening hours",
              shouldBeCaptured: false,
            });
          }
          await updateWorkingHoursSchedule({
            organizationId,
            weeklySchedule: validation.data,
          });
          sendNotification({
            title: "Opening hours updated",
            message: "The weekly IOIO Lab schedule was updated.",
            icon: { name: "success", variant: "success" },
            senderId: userId,
          });
          return data(payload({ success: true }), { status: 200 });
        }
        case "createOverride": {
          const values = parseData(formData, CreateOverrideFormSchema);
          await createWorkingHoursOverride({
            organizationId,
            date: values.date,
            isOpen: values.isOpen,
            openTime: values.openTime || undefined,
            closeTime: values.closeTime || undefined,
            reason: values.reason,
          });
          sendNotification({
            title: "Opening-hours exception added",
            message: "The date-specific opening-hours exception was saved.",
            icon: { name: "success", variant: "success" },
            senderId: userId,
          });
          return data(payload({ success: true }), { status: 200 });
        }
        case "deleteOverride": {
          const overrideId = String(formData.get("overrideId") ?? "");
          if (!overrideId) {
            throw new ShelfError({
              cause: null,
              message: "Opening-hours exception ID is required.",
              label: "Opening hours",
              shouldBeCaptured: false,
            });
          }
          await deleteWorkingHoursOverride(overrideId, organizationId);
          sendNotification({
            title: "Opening-hours exception removed",
            message: "The date-specific exception was removed.",
            icon: { name: "success", variant: "success" },
            senderId: userId,
          });
          return data(payload({ success: true }), { status: 200 });
        }
      }
    }

    if (intent === "add-ta") {
      const userIdToAdd = String(formData.get("userId") ?? "");
      if (!userIdToAdd) throw new Error("Choose a Staff member first.");
      await addLabTA({ organizationId, userId: userIdToAdd });
      return payload({ success: true, message: "Lab TA added." });
    }

    if (intent === "remove-ta") {
      const userIdToRemove = String(formData.get("userId") ?? "");
      if (!userIdToRemove) throw new Error("The Lab TA could not be found.");
      await removeLabTA({ organizationId, userId: userIdToRemove });
      return payload({ success: true, message: "Lab TA removed." });
    }

    if (intent === "review-tas") {
      await markLabTAsReviewed(organizationId);
      return payload({
        success: true,
        message: "Lab TA list marked as reviewed.",
      });
    }

    throw new Error("Unsupported Lab information action.");
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    return data(error(reason), { status: reason.status });
  }
}

async function requireWorkingHoursPermission({
  userId,
  request,
  organizationId,
}: {
  userId: string;
  request: Request;
  organizationId: string;
}) {
  const permission = await requirePermission({
    userId,
    request,
    entity: PermissionEntity.workingHours,
    action: PermissionAction.update,
  });
  if (
    permission.organizationId !== organizationId ||
    permission.currentOrganization.type === OrganizationType.PERSONAL
  ) {
    throw new ShelfError({
      cause: null,
      title: "Not allowed",
      message: "You are not allowed to manage these opening hours.",
      label: "Settings",
      status: 403,
      shouldBeCaptured: false,
    });
  }
}

const fieldLabels = {
  aboutText: "About",
  borrowingText: "How borrowing works",
  rulesText: "Rules",
  returnText: "Returns",
  helpText: "Help",
} as const;

export const handle = { breadcrumb: () => "Lab information" };

export const meta: MetaFunction<typeof loader> = () => [
  { title: appendToMetaTitle("Lab information") },
];

function DeleteCustomSection({
  sectionKey,
  title,
}: {
  sectionKey: string;
  title: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex w-full items-center rounded px-3 py-2 text-left text-sm text-red-700 hover:bg-red-50"
      >
        Delete section
      </button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this section?</AlertDialogTitle>
            <AlertDialogDescription>
              “{title}” and its supporting images will be removed from the
              Student Lab Info page.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Form method="post">
            <input type="hidden" name="intent" value="delete-section" />
            <input type="hidden" name="sectionKey" value={sectionKey} />
            <AlertDialogFooter>
              <AlertDialogCancel asChild>
                <Button type="button" variant="secondary">
                  Cancel
                </Button>
              </AlertDialogCancel>
              <Button type="submit" variant="destructive">
                Delete section
              </Button>
            </AlertDialogFooter>
          </Form>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function moveKey(keys: string[], index: number, direction: "up" | "down") {
  const target = direction === "up" ? index - 1 : index + 1;
  if (index === 0 || target < 0 || target >= keys.length) return keys;
  const reordered = [...keys];
  [reordered[index], reordered[target]] = [reordered[target], reordered[index]];
  return reordered;
}

export default function LabInformationSettingsPage() {
  const information = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const location = useLocation();
  const [activeSection, setActiveSection] = useState(
    location.hash === "#opening-hours" ? "opening-hours" : "about"
  );
  const [isAddingSection, setIsAddingSection] = useState(false);
  useEffect(() => {
    if (
      actionData &&
      "activeSectionKey" in actionData &&
      typeof actionData.activeSectionKey === "string"
    ) {
      setActiveSection(actionData.activeSectionKey);
      setIsAddingSection(false);
    }
  }, [actionData]);

  const active = information.sections.find(
    (section) => section.key === activeSection
  );
  const selectedTAs = information.candidates.filter(
    (candidate) => candidate.selected
  );
  const availableTAs = information.candidates.filter(
    (candidate) => !candidate.selected
  );
  const actionMessage =
    actionData && "message" in actionData ? actionData.message : null;
  const actionError =
    actionData && "error" in actionData && actionData.error
      ? actionData.error.message
      : null;

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6">
      <div
        className="mb-3 flex flex-wrap items-center gap-2"
        aria-label="Lab information sections"
      >
        {information.sections.map((section) => (
          <button
            key={section.key}
            type="button"
            onClick={() => setActiveSection(section.key)}
            aria-pressed={activeSection === section.key}
            className={`rounded-md px-3 py-2 text-sm font-medium ${
              activeSection === section.key
                ? "bg-primary-600 text-white"
                : "bg-gray-100 text-gray-700 hover:bg-gray-200"
            }`}
          >
            {section.title}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setIsAddingSection((open) => !open)}
          className="rounded-md border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
        >
          + Add section
        </button>
      </div>

      <details
        open
        className="mb-4 rounded-lg border border-gray-200 bg-white px-3 py-2"
      >
        <summary className="cursor-pointer text-sm font-medium text-gray-700">
          Arrange sections
        </summary>
        <ol className="mt-2 divide-y divide-gray-100">
          {information.sections.map((section, index) => {
            const keys = information.sections.map((item) => item.key);
            const upKeys = moveKey(keys, index, "up");
            const downKeys = moveKey(keys, index, "down");
            const positionFixed = section.key === "about";
            return (
              <li
                key={section.key}
                className="flex flex-wrap items-center justify-between gap-3 py-2"
              >
                <span className="text-sm text-gray-800">
                  {index + 1}. {section.title}
                  {positionFixed ? (
                    <span className="ml-2 text-xs text-gray-500">
                      Always first
                    </span>
                  ) : null}
                </span>
                {!positionFixed ? (
                  <div className="flex gap-2">
                    <ReorderForm
                      keys={upKeys}
                      label="Move up"
                      disabled={index <= 1}
                    />
                    <ReorderForm
                      keys={downKeys}
                      label="Move down"
                      disabled={index === information.sections.length - 1}
                    />
                  </div>
                ) : null}
              </li>
            );
          })}
        </ol>
      </details>

      {isAddingSection ? (
        <Form
          method="post"
          className="mb-4 grid gap-3 rounded-lg border border-gray-200 bg-white p-4 sm:grid-cols-2"
        >
          <input type="hidden" name="intent" value="add-section" />
          <label className="text-sm font-medium text-gray-800">
            Section title
            <input
              name="title"
              required
              maxLength={120}
              placeholder="e.g. Safety"
              className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm font-normal"
            />
          </label>
          <label className="text-sm font-medium text-gray-800 sm:row-span-2">
            Content
            <textarea
              name="value"
              rows={4}
              maxLength={5000}
              className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm font-normal"
            />
          </label>
          <div className="flex items-end gap-2">
            <Button type="submit">Add section</Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => setIsAddingSection(false)}
            >
              Cancel
            </Button>
          </div>
        </Form>
      ) : null}

      {actionMessage ? (
        <p className="mb-4 rounded-md bg-green-50 px-3 py-2 text-sm text-green-800">
          {actionMessage}
        </p>
      ) : null}
      {actionError ? (
        <p className="mb-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-800">
          {actionError}
        </p>
      ) : null}

      {active?.kind === "opening-hours" ? (
        <div className="space-y-4">
          {information.canManageWorkingHours ? (
            <>
              <EnableWorkingHoursForm
                enabled={information.workingHours.enabled}
                header={{
                  title: "IOIO Lab opening hours",
                  subHeading:
                    "These hours are shown to borrowers and used when scheduling Staff preparation and pickup.",
                }}
              />
              {information.workingHours.enabled ? (
                <>
                  <WeeklyScheduleForm
                    weeklySchedule={
                      information.workingHours
                        .weeklySchedule as unknown as WeeklyScheduleJson
                    }
                  />
                  <Overrides overrides={information.workingHours.overrides} />
                </>
              ) : null}
            </>
          ) : (
            <section className="rounded-lg border border-gray-200 bg-white p-5 text-sm text-gray-600 shadow-sm">
              You can view the configured opening hours, but you do not have
              permission to edit them.
            </section>
          )}
        </div>
      ) : null}

      {active?.kind === "lab-tas" ? (
        <section className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-gray-900">Lab TAs</h2>
              <p className="mt-1 text-sm text-gray-600">
                Select the Staff members who should be shown publicly as Lab
                TAs.
              </p>
            </div>
            <Form method="post">
              <input type="hidden" name="intent" value="review-tas" />
              <Button type="submit" variant="secondary">
                {information.taReviewDue ? "Review TA list" : "Mark reviewed"}
              </Button>
            </Form>
          </div>
          <p className="mt-3 text-xs text-gray-500">
            {information.taReviewDue
              ? `Annual review due for ${information.academicYear}. Selected TAs are never removed automatically.`
              : `Last reviewed for ${information.academicYear}.`}
          </p>

          <div className="mt-5 space-y-2">
            <h3 className="text-sm font-semibold text-gray-900">
              Visible Lab TAs
            </h3>
            {selectedTAs.length ? (
              selectedTAs.map((candidate) => (
                <div
                  key={candidate.id}
                  className="flex items-center justify-between gap-3 rounded-md border border-gray-200 px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-gray-900">
                      {candidate.name || "Unnamed Staff member"}
                    </p>
                    <p className="truncate text-xs text-gray-500">
                      {candidate.email}
                    </p>
                  </div>
                  <Form method="post">
                    <input type="hidden" name="intent" value="remove-ta" />
                    <input type="hidden" name="userId" value={candidate.id} />
                    <Button type="submit" variant="secondary">
                      Remove
                    </Button>
                  </Form>
                </div>
              ))
            ) : (
              <p className="text-sm text-gray-500">
                No Lab TAs are selected yet.
              </p>
            )}
          </div>

          <div className="mt-6 border-t border-gray-100 pt-5">
            <h3 className="text-sm font-semibold text-gray-900">
              Add a Staff member
            </h3>
            <Form
              method="post"
              className="mt-2 flex flex-wrap items-center gap-2"
            >
              <input type="hidden" name="intent" value="add-ta" />
              <select
                name="userId"
                required
                defaultValue=""
                className="min-w-0 flex-1 rounded-md border border-gray-300 px-3 py-2 text-sm"
              >
                <option value="" disabled>
                  Choose Staff member
                </option>
                {availableTAs.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.name || candidate.email}
                    {candidate.suggested ? " · recently added" : ""}
                  </option>
                ))}
              </select>
              <Button type="submit">Add Lab TA</Button>
            </Form>
          </div>
        </section>
      ) : null}

      {active && !active.kind ? (
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-gray-600">
              Edit this Student-facing section and its optional supporting
              images.
            </p>
            {active.isCustom ? (
              <details className="relative">
                <summary
                  aria-label={`${active.title} section actions`}
                  className="flex size-9 cursor-pointer list-none items-center justify-center rounded-md border border-gray-300 text-gray-700 hover:bg-gray-50"
                >
                  <MoreHorizontal className="size-4" aria-hidden="true" />
                </summary>
                <div className="absolute right-0 z-10 mt-1 w-44 rounded-md border border-gray-200 bg-white p-1 shadow-lg">
                  <DeleteCustomSection
                    sectionKey={active.key}
                    title={active.title}
                  />
                </div>
              </details>
            ) : null}
          </div>
          <LabInfoSectionEditor key={active.key} section={active} />
        </div>
      ) : null}
    </div>
  );
}

function ReorderForm({
  keys,
  label,
  disabled,
}: {
  keys: string[];
  label: string;
  disabled: boolean;
}) {
  return (
    <Form method="post">
      <input type="hidden" name="intent" value="reorder-sections" />
      {keys.map((key) => (
        <input key={key} type="hidden" name="sectionKey" value={key} />
      ))}
      <button
        type="submit"
        disabled={disabled}
        className="rounded border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {label}
      </button>
    </Form>
  );
}

export const ErrorBoundary = () => <ErrorContent />;
