import { OrganizationRoles } from "@prisma/client";
import { db } from "~/database/db.server";
import { PUBLIC_BUCKET } from "~/utils/constants";
import { id } from "~/utils/id/id.server";
import { Logger } from "~/utils/logger";
import {
  getPublicFileURL,
  removeStorageImageObject,
} from "~/utils/storage.server";
import { resolveUserDisplayName } from "~/utils/user";
import {
  BUILT_IN_LAB_INFO_SECTIONS,
  orderLabInfoSections,
} from "./sections.shared";

export const DEFAULT_LAB_INFORMATION = {
  aboutText:
    "IOIO Lab is a shared space for experimenting, prototyping, and working with electronics, physical computing, fabrication tools, and related equipment.\n\nYou can browse available equipment, borrow items for projects, and get help from Lab Staff and TAs.",
  borrowingText:
    "Browse equipment and add what you need to your borrow list.\n\nSome items can be borrowed immediately. Others need Staff preparation before pickup.\n\nWhen an item is ready, you will see it in My Loans and receive a notification. Return it by the shown date.",
  rulesText:
    "Help keep IOIO Lab organized\n\n- Return equipment by the shown return date.\n- Return items to the location shown in the return flow.\n- Keep kits and their parts together.\n- Report damage, missing parts, or problems as soon as possible.\n- Do not move equipment to a different storage location without Staff approval.\n- Leave the workspace and equipment ready for the next person.",
  returnText:
    "When you return an item, My Loans will show where it should be placed.\n\nSome items return directly to storage. Others go to the Return Zone so Staff can check them before they become available again.\n\nIf something is damaged or missing, report it during the return process.",
  helpText:
    "Ask a Lab TA during opening hours.\n\nFor issues with borrowed equipment, use Report a problem from My Loans.\n\nFor account or access questions, contact IOIO Lab Staff.",
};

const STAFF_ROLES = [OrganizationRoles.ADMIN, OrganizationRoles.OWNER];

export type LabTextField = keyof typeof DEFAULT_LAB_INFORMATION;

export function getAcademicYear(date = new Date()) {
  const year = date.getFullYear();
  return date.getMonth() >= 8 ? `${year}-${year + 1}` : `${year - 1}-${year}`;
}

function withDefaults(
  row: {
    aboutText: string;
    borrowingText: string;
    rulesText: string;
    returnText: string;
    helpText: string;
    taLastReviewedAt: Date | null;
    taLastReviewedAcademicYear: string | null;
  } | null
) {
  return {
    aboutText: row?.aboutText || DEFAULT_LAB_INFORMATION.aboutText,
    borrowingText: row?.borrowingText || DEFAULT_LAB_INFORMATION.borrowingText,
    rulesText: row?.rulesText || DEFAULT_LAB_INFORMATION.rulesText,
    returnText: row?.returnText || DEFAULT_LAB_INFORMATION.returnText,
    helpText: row?.helpText || DEFAULT_LAB_INFORMATION.helpText,
    taLastReviewedAt: row?.taLastReviewedAt?.toISOString() ?? null,
    taLastReviewedAcademicYear: row?.taLastReviewedAcademicYear ?? null,
  };
}

const labInformationSelect = {
  aboutText: true,
  borrowingText: true,
  rulesText: true,
  returnText: true,
  helpText: true,
  taLastReviewedAt: true,
  taLastReviewedAcademicYear: true,
} as const;

const sectionSelect = {
  id: true,
  key: true,
  title: true,
  content: true,
  position: true,
  isCustom: true,
  images: {
    orderBy: { position: "asc" as const },
    select: {
      id: true,
      storagePath: true,
      position: true,
      caption: true,
      altText: true,
    },
  },
} as const;

const taUserSelect = {
  firstName: true,
  lastName: true,
  displayName: true,
  profilePicture: true,
} as const;

export async function getLabInformation(organizationId: string) {
  const [information, assignments, sectionRows] = await Promise.all([
    db.ioioLabInformation.findUnique({
      where: { organizationId },
      select: labInformationSelect,
    }),
    db.ioioLabTA.findMany({
      where: {
        organizationId,
        user: { deletedAt: null },
      },
      orderBy: { createdAt: "asc" },
      select: { user: { select: taUserSelect } },
    }),
    db.ioioLabInformationSection.findMany({
      where: { organizationId },
      orderBy: { position: "asc" },
      select: sectionSelect,
    }),
  ]);

  const defaults = withDefaults(information);

  return {
    ...defaults,
    tas: assignments.map(({ user }) => ({
      name: resolveUserDisplayName(user),
      profilePicture: user.profilePicture,
    })),
    sections: serializeSections(sectionRows, defaults),
  };
}

export async function getStaffLabInformation(organizationId: string) {
  const [information, assignments, candidates, sectionRows] = await Promise.all(
    [
      db.ioioLabInformation.findUnique({
        where: { organizationId },
        select: labInformationSelect,
      }),
      db.ioioLabTA.findMany({
        where: { organizationId },
        select: { userId: true },
      }),
      db.userOrganization.findMany({
        where: {
          organizationId,
          roles: { hasSome: STAFF_ROLES },
          user: { deletedAt: null },
        },
        orderBy: { createdAt: "desc" },
        select: {
          userId: true,
          user: {
            select: {
              ...taUserSelect,
              email: true,
              createdAt: true,
            },
          },
        },
      }),
      db.ioioLabInformationSection.findMany({
        where: { organizationId },
        orderBy: { position: "asc" },
        select: sectionSelect,
      }),
    ]
  );

  const defaults = withDefaults(information);

  const selectedIds = new Set(assignments.map(({ userId }) => userId));
  const sixMonthsAgo = new Date();
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

  return {
    ...defaults,
    sections: serializeSections(sectionRows, defaults),
    candidates: candidates.map(({ userId, user }) => ({
      id: userId,
      name: resolveUserDisplayName(user),
      email: user.email,
      profilePicture: user.profilePicture,
      selected: selectedIds.has(userId),
      suggested: user.createdAt >= sixMonthsAgo,
    })),
    academicYear: getAcademicYear(),
    taReviewDue: information?.taLastReviewedAcademicYear !== getAcademicYear(),
  };
}

function serializeSections(
  rows: Array<{
    id: string;
    key: string;
    title: string | null;
    content: string | null;
    position: number;
    isCustom: boolean;
    images: Array<{
      id: string;
      storagePath: string;
      position: number;
      caption: string | null;
      altText: string | null;
    }>;
  }>,
  information: Record<LabTextField, string>
) {
  const rowsByKey = new Map(rows.map((row) => [row.key, row]));
  const builtIns = BUILT_IN_LAB_INFO_SECTIONS.map((definition, index) => {
    const row = rowsByKey.get(definition.key);
    const field = "field" in definition ? definition.field : undefined;
    return {
      key: definition.key,
      title: definition.title,
      position: row?.position ?? index,
      isCustom: false,
      field,
      kind: "kind" in definition ? definition.kind : undefined,
      text: field ? information[field] : "",
      images: (row?.images ?? []).map((image) => ({
        id: image.id,
        url: getPublicFileURL({
          filename: image.storagePath,
          bucketName: PUBLIC_BUCKET,
        }),
        position: image.position,
        caption: image.caption,
        altText: image.altText,
      })),
    };
  });

  const customSections = rows
    .filter((row) => row.isCustom && row.title)
    .map((row) => ({
      key: row.key,
      title: row.title as string,
      position: row.position,
      isCustom: true,
      kind: undefined,
      text: row.content ?? "",
      images: row.images.map((image) => ({
        id: image.id,
        url: getPublicFileURL({
          filename: image.storagePath,
          bucketName: PUBLIC_BUCKET,
        }),
        position: image.position,
        caption: image.caption,
        altText: image.altText,
      })),
    }));

  return orderLabInfoSections([...builtIns, ...customSections]);
}

export async function createCustomLabInfoSection({
  organizationId,
  title,
  content,
}: {
  organizationId: string;
  title: string;
  content: string;
}) {
  const normalizedTitle = title.trim();
  if (!normalizedTitle || normalizedTitle.length > 120) {
    throw new Error("Section title must be between 1 and 120 characters.");
  }
  const rows = await db.ioioLabInformationSection.findMany({
    where: { organizationId },
    select: { position: true },
  });
  const lastDefaultPosition = BUILT_IN_LAB_INFO_SECTIONS.length - 1;
  const position =
    Math.max(lastDefaultPosition, ...rows.map((row) => row.position)) + 1;
  const key = `custom_${id(16)}`;
  return db.ioioLabInformationSection.create({
    data: {
      organizationId,
      key,
      title: normalizedTitle,
      content: content.slice(0, 5000),
      position,
      isCustom: true,
    },
    select: { key: true, title: true },
  });
}

export async function updateCustomLabInfoSection({
  organizationId,
  key,
  title,
  content,
}: {
  organizationId: string;
  key: string;
  title: string;
  content: string;
}) {
  const normalizedTitle = title.trim();
  if (!normalizedTitle || normalizedTitle.length > 120) {
    throw new Error("Section title must be between 1 and 120 characters.");
  }
  return db.ioioLabInformationSection.update({
    where: { organizationId_key: { organizationId, key }, isCustom: true },
    data: { title: normalizedTitle, content: content.slice(0, 5000) },
  });
}

export async function reorderLabInfoSections({
  organizationId,
  orderedKeys,
}: {
  organizationId: string;
  orderedKeys: string[];
}) {
  const customRows = await db.ioioLabInformationSection.findMany({
    where: { organizationId, isCustom: true },
    select: { key: true },
  });
  const expectedKeys = [
    ...BUILT_IN_LAB_INFO_SECTIONS.map(({ key }) => key),
    ...customRows.map(({ key }) => key),
  ];
  if (
    orderedKeys.length !== expectedKeys.length ||
    new Set(orderedKeys).size !== expectedKeys.length ||
    expectedKeys.some((key) => !orderedKeys.includes(key)) ||
    orderedKeys[0] !== "about"
  ) {
    throw new Error("The Lab Info section order is invalid.");
  }

  await Promise.all(
    BUILT_IN_LAB_INFO_SECTIONS.map((section, defaultPosition) =>
      db.ioioLabInformationSection.upsert({
        where: { organizationId_key: { organizationId, key: section.key } },
        create: {
          organizationId,
          key: section.key,
          position: defaultPosition,
          isCustom: false,
        },
        update: {},
      })
    )
  );
  await db.$transaction(
    orderedKeys.map((key, position) =>
      db.ioioLabInformationSection.update({
        where: { organizationId_key: { organizationId, key } },
        data: { position },
      })
    )
  );
}

async function getOrCreateLabInfoSection({
  organizationId,
  key,
}: {
  organizationId: string;
  key: string;
}) {
  const builtinIndex = BUILT_IN_LAB_INFO_SECTIONS.findIndex(
    (section) => section.key === key
  );
  if (builtinIndex >= 0) {
    return db.ioioLabInformationSection.upsert({
      where: { organizationId_key: { organizationId, key } },
      create: { organizationId, key, position: builtinIndex, isCustom: false },
      update: {},
      select: { id: true },
    });
  }
  const section = await db.ioioLabInformationSection.findFirst({
    where: { organizationId, key, isCustom: true },
    select: { id: true },
  });
  if (!section) throw new Error("Lab Info section not found.");
  return section;
}

export async function createLabInfoImage({
  organizationId,
  sectionKey,
  storagePath,
  caption,
  altText,
}: {
  organizationId: string;
  sectionKey: string;
  storagePath: string;
  caption: string;
  altText: string;
}) {
  const section = await getOrCreateLabInfoSection({
    organizationId,
    key: sectionKey,
  });
  const existingCount = await db.ioioLabInformationImage.count({
    where: { sectionId: section.id },
  });
  if (existingCount >= 8) throw new Error("A section can have up to 8 images.");
  return db.ioioLabInformationImage.create({
    data: {
      sectionId: section.id,
      storagePath,
      position: existingCount,
      caption: caption.trim() || null,
      altText: altText.trim() || null,
    },
  });
}

export async function updateLabInfoImage({
  organizationId,
  sectionKey,
  imageId,
  caption,
  altText,
}: {
  organizationId: string;
  sectionKey: string;
  imageId: string;
  caption: string;
  altText: string;
}) {
  const image = await db.ioioLabInformationImage.findFirst({
    where: { id: imageId, section: { organizationId, key: sectionKey } },
    select: { id: true },
  });
  if (!image) throw new Error("Lab Info image not found.");
  return db.ioioLabInformationImage.update({
    where: { id: imageId },
    data: {
      caption: caption.trim() || null,
      altText: altText.trim() || null,
    },
  });
}

export async function updateLabInfoSectionImages({
  organizationId,
  sectionKey,
  images,
}: {
  organizationId: string;
  sectionKey: string;
  images: Array<{ id: string; caption: string; altText: string }>;
}) {
  return db.$transaction(async (tx) => {
    const currentImages = await tx.ioioLabInformationImage.findMany({
      where: { section: { organizationId, key: sectionKey } },
      orderBy: { position: "asc" },
      select: { id: true },
    });

    const currentIds = new Set(currentImages.map(({ id }) => id));
    if (
      images.length !== currentImages.length ||
      images.some(({ id }) => !currentIds.has(id)) ||
      new Set(images.map(({ id }) => id)).size !== images.length
    ) {
      throw new Error(
        "The image list changed while you were editing. Refresh and try again."
      );
    }

    await Promise.all(
      images.map((image, position) =>
        tx.ioioLabInformationImage.update({
          where: { id: image.id },
          data: {
            position,
            caption: image.caption.trim() || null,
            altText: image.altText.trim() || null,
          },
        })
      )
    );
  });
}

export async function moveLabInfoImage({
  organizationId,
  sectionKey,
  imageId,
  direction,
}: {
  organizationId: string;
  sectionKey: string;
  imageId: string;
  direction: "up" | "down";
}) {
  const images = await db.ioioLabInformationImage.findMany({
    where: { section: { organizationId, key: sectionKey } },
    orderBy: { position: "asc" },
    select: { id: true, position: true },
  });
  const current = images.findIndex((image) => image.id === imageId);
  if (current < 0) throw new Error("Lab Info image not found.");
  const sectionImages = images;
  const index = current;
  const target = direction === "up" ? index - 1 : index + 1;
  if (target < 0 || target >= sectionImages.length) return;
  [sectionImages[index], sectionImages[target]] = [
    sectionImages[target],
    sectionImages[index],
  ];
  await db.$transaction(
    sectionImages.map((image, position) =>
      db.ioioLabInformationImage.update({
        where: { id: image.id },
        data: { position },
      })
    )
  );
}

export async function removeLabInfoImage({
  organizationId,
  sectionKey,
  imageId,
}: {
  organizationId: string;
  sectionKey: string;
  imageId: string;
}) {
  const image = await db.ioioLabInformationImage.findFirst({
    where: { id: imageId, section: { organizationId, key: sectionKey } },
    select: { id: true, storagePath: true },
  });
  if (!image) throw new Error("Lab Info image not found.");
  await db.ioioLabInformationImage.delete({ where: { id: image.id } });
  await cleanupLabInfoStoragePath(image.storagePath, "image removal");
}

export async function replaceLabInfoImage({
  organizationId,
  sectionKey,
  imageId,
  storagePath,
}: {
  organizationId: string;
  sectionKey: string;
  imageId: string;
  storagePath: string;
}) {
  const image = await db.ioioLabInformationImage.findFirst({
    where: { id: imageId, section: { organizationId, key: sectionKey } },
    select: { id: true, storagePath: true },
  });
  if (!image) throw new Error("Lab Info image not found.");
  await db.ioioLabInformationImage.update({
    where: { id: imageId },
    data: { storagePath },
  });
  if (image.storagePath !== storagePath) {
    await cleanupLabInfoStoragePath(image.storagePath, "image replacement");
  }
}

export async function deleteCustomLabInfoSection({
  organizationId,
  key,
}: {
  organizationId: string;
  key: string;
}) {
  const section = await db.ioioLabInformationSection.findFirst({
    where: { organizationId, key, isCustom: true },
    select: { id: true, images: { select: { storagePath: true } } },
  });
  if (!section) throw new Error("Custom Lab Info section not found.");
  await db.ioioLabInformationSection.delete({
    where: {
      organizationId_key: { organizationId, key },
    },
  });
  await Promise.all(
    section.images.map(({ storagePath }) =>
      cleanupLabInfoStoragePath(storagePath, "section deletion")
    )
  );
}

async function cleanupLabInfoStoragePath(path: string, operation: string) {
  try {
    await removeStorageImageObject({
      bucketName: PUBLIC_BUCKET,
      objectPath: path,
    });
  } catch (cause) {
    Logger.dev("[IOIO LAB INFO] storage cleanup failed", {
      operation,
      message: cause instanceof Error ? cause.message : String(cause),
    });
  }
}

async function ensureStaffMember({
  organizationId,
  userId,
}: {
  organizationId: string;
  userId: string;
}) {
  const membership = await db.userOrganization.findFirst({
    where: {
      organizationId,
      userId,
      roles: { hasSome: STAFF_ROLES },
      user: { deletedAt: null },
    },
    select: { userId: true },
  });
  if (!membership) {
    throw new Error("Select an active Staff member from this organization.");
  }
}

export async function updateLabInformation({
  organizationId,
  ...fields
}: { organizationId: string } & Record<LabTextField, string>) {
  const values = Object.fromEntries(
    (Object.keys(DEFAULT_LAB_INFORMATION) as LabTextField[]).map((key) => [
      key,
      fields[key].trim() || DEFAULT_LAB_INFORMATION[key],
    ])
  ) as Record<LabTextField, string>;

  return db.ioioLabInformation.upsert({
    where: { organizationId },
    create: { organizationId, ...values },
    update: values,
    select: labInformationSelect,
  });
}

export async function updateLabInformationField({
  organizationId,
  field,
  value,
}: {
  organizationId: string;
  field: LabTextField;
  value: string;
}) {
  const normalizedValue = value.trim() || DEFAULT_LAB_INFORMATION[field];

  return db.ioioLabInformation.upsert({
    where: { organizationId },
    create: {
      organizationId,
      ...DEFAULT_LAB_INFORMATION,
      [field]: normalizedValue,
    },
    update: { [field]: normalizedValue },
    select: labInformationSelect,
  });
}

export async function addLabTA({
  organizationId,
  userId,
}: {
  organizationId: string;
  userId: string;
}) {
  await ensureStaffMember({ organizationId, userId });
  return db.ioioLabTA.upsert({
    where: { organizationId_userId: { organizationId, userId } },
    create: { organizationId, userId },
    update: {},
  });
}

export function removeLabTA({
  organizationId,
  userId,
}: {
  organizationId: string;
  userId: string;
}) {
  return db.ioioLabTA.deleteMany({ where: { organizationId, userId } });
}

export async function markLabTAsReviewed(organizationId: string) {
  const now = new Date();
  return db.ioioLabInformation.upsert({
    where: { organizationId },
    create: {
      organizationId,
      ...DEFAULT_LAB_INFORMATION,
      taLastReviewedAt: now,
      taLastReviewedAcademicYear: getAcademicYear(now),
    },
    update: {
      taLastReviewedAt: now,
      taLastReviewedAcademicYear: getAcademicYear(now),
    },
    select: labInformationSelect,
  });
}
