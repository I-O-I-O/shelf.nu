import type { CardAccessRequestStatus as PrismaCardAccessRequestStatus } from "@prisma/client";
import { db } from "~/database/db.server";
import { triggerEmail } from "~/emails/email.worker.server";
import { ShelfError } from "~/utils/error";
import { resolveUserDisplayName } from "~/utils/user";
import { CARD_ACCESS_REQUEST_STATUS as CardAccessRequestStatus } from "./card-access.constants";

const ACTIVE_STATUSES: PrismaCardAccessRequestStatus[] = [
  CardAccessRequestStatus.WAITING_FOR_SUBMISSION,
  CardAccessRequestStatus.SUBMITTED,
  CardAccessRequestStatus.NEEDS_ATTENTION,
];
const VISIBLE_OWN_STATUSES = [
  ...ACTIVE_STATUSES,
  CardAccessRequestStatus.APPROVED,
];

const APPLICANT_SELECT = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
  displayName: true,
} as const;

export type CardAccessPerson = {
  id: string;
  name: string;
  email: string;
};

function personFromUser(user: {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  displayName: string | null;
}): CardAccessPerson {
  return {
    id: user.id,
    email: user.email,
    name: resolveUserDisplayName(user) || user.email,
  };
}

export function validateCardNumber(value: string) {
  const cardNumber = value.trim();
  if (!/^\d{10}$/.test(cardNumber)) {
    throw new ShelfError({
      cause: null,
      message: "Card number must be exactly 10 digits.",
      label: "User",
      shouldBeCaptured: false,
      status: 400,
    });
  }
  return cardNumber;
}

export async function getStudentCardAccessData({
  organizationId,
  userId,
}: {
  organizationId: string;
  userId: string;
}) {
  const request = await db.cardAccessRequest.findFirst({
    where: {
      organizationId,
      applicantId: userId,
      status: { in: VISIBLE_OWN_STATUSES },
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      cardNumber: true,
      status: true,
      consentConfirmedAt: true,
      submittedAt: true,
      approvedAt: true,
      createdAt: true,
    },
  });

  const waiting = await db.cardAccessRequest.findMany({
    where: { organizationId, status: { in: ACTIVE_STATUSES } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      applicant: { select: APPLICANT_SELECT },
    },
  });

  return {
    request,
    waiting: waiting.map(({ applicant }) => ({
      id: applicant.id,
      name: resolveUserDisplayName(applicant) || applicant.email,
    })),
  };
}

export async function createStudentCardAccessRequest({
  organizationId,
  userId,
  cardNumber,
}: {
  organizationId: string;
  userId: string;
  cardNumber: string;
}) {
  const normalizedCardNumber = validateCardNumber(cardNumber);
  const existing = await db.cardAccessRequest.findFirst({
    where: {
      organizationId,
      applicantId: userId,
      status: { in: ACTIVE_STATUSES },
    },
    select: { id: true },
  });

  if (existing) {
    const needsAttention = await db.cardAccessRequest.findFirst({
      where: {
        id: existing.id,
        organizationId,
        applicantId: userId,
        status: CardAccessRequestStatus.NEEDS_ATTENTION,
      },
      select: { id: true },
    });
    if (needsAttention) {
      await db.cardAccessRequest.updateMany({
        where: { id: needsAttention.id, organizationId, applicantId: userId },
        data: {
          cardNumber: normalizedCardNumber,
          status: CardAccessRequestStatus.WAITING_FOR_SUBMISSION,
          consentConfirmedAt: new Date(),
          submittedAt: null,
          approvedAt: null,
          cancelledAt: null,
        },
      });
      return needsAttention;
    }
    throw new ShelfError({
      cause: null,
      message: "You already have an active card access request.",
      label: "User",
      shouldBeCaptured: false,
      status: 409,
    });
  }

  return db.cardAccessRequest.create({
    data: {
      organizationId,
      applicantId: userId,
      cardNumber: normalizedCardNumber,
      consentConfirmedAt: new Date(),
    },
    select: { id: true },
  });
}

export async function cancelStudentCardAccessRequest({
  organizationId,
  userId,
}: {
  organizationId: string;
  userId: string;
}) {
  const request = await db.cardAccessRequest.findFirst({
    where: {
      organizationId,
      applicantId: userId,
      status: { in: ACTIVE_STATUSES },
    },
    select: { id: true },
  });
  if (!request) return;

  await db.cardAccessRequest.updateMany({
    where: { id: request.id, organizationId, applicantId: userId },
    data: {
      status: CardAccessRequestStatus.CANCELLED,
      cancelledAt: new Date(),
    },
  });
}

export async function getStaffCardAccessData({
  organizationId,
}: {
  organizationId: string;
}) {
  const requests = await db.cardAccessRequest.findMany({
    where: {
      organizationId,
      status: { not: CardAccessRequestStatus.CANCELLED },
    },
    orderBy: [{ status: "asc" }, { createdAt: "asc" }],
    select: {
      id: true,
      cardNumber: true,
      status: true,
      consentConfirmedAt: true,
      submittedAt: true,
      approvedAt: true,
      createdAt: true,
      applicant: { select: APPLICANT_SELECT },
    },
  });

  const members = await db.userOrganization.findMany({
    where: { organizationId },
    select: { user: { select: APPLICANT_SELECT }, roles: true },
    orderBy: { createdAt: "asc" },
  });

  const people = members.map(({ user }) => personFromUser(user));
  const staff = members
    .filter(({ roles }) =>
      roles.some((role) => role === "ADMIN" || role === "OWNER")
    )
    .map(({ user }) => personFromUser(user));

  return {
    requests: requests.map((request) => ({
      ...request,
      // Card numbers are only needed while a request is still waiting to be
      // included in a teacher batch. Once submitted, keep them out of the
      // normal Staff response as well as out of the UI.
      cardNumber:
        request.status === CardAccessRequestStatus.WAITING_FOR_SUBMISSION
          ? request.cardNumber
          : null,
    })),
    people,
    staff,
  };
}

async function getStaffRecipient({
  organizationId,
  userId,
}: {
  organizationId: string;
  userId: string;
}) {
  const membership = await db.userOrganization.findFirst({
    where: { organizationId, userId },
    select: { roles: true, user: { select: APPLICANT_SELECT } },
  });
  if (
    !membership ||
    !membership.roles.some((role) => role === "ADMIN" || role === "OWNER")
  ) {
    throw new ShelfError({
      cause: null,
      message: "Select a Staff member as the recipient.",
      label: "User",
      shouldBeCaptured: false,
    });
  }
  return membership.user;
}

async function getBatchRequests({
  organizationId,
  requestIds,
}: {
  organizationId: string;
  requestIds: string[];
}) {
  const uniqueIds = [...new Set(requestIds.filter(Boolean))];
  if (uniqueIds.length === 0) {
    throw new ShelfError({
      cause: null,
      message: "Select at least one person.",
      label: "User",
      shouldBeCaptured: false,
    });
  }

  const requests = await db.cardAccessRequest.findMany({
    where: {
      organizationId,
      id: { in: uniqueIds },
      status: CardAccessRequestStatus.WAITING_FOR_SUBMISSION,
    },
    select: {
      id: true,
      cardNumber: true,
      applicant: { select: APPLICANT_SELECT },
    },
  });

  if (requests.length !== uniqueIds.length) {
    throw new ShelfError({
      cause: null,
      message: "Refresh the queue and select only waiting requests.",
      label: "User",
      shouldBeCaptured: false,
    });
  }
  return requests;
}

function batchLines(
  requests: Array<{
    cardNumber: string;
    applicant: {
      email: string;
      firstName: string | null;
      lastName: string | null;
      displayName: string | null;
    };
  }>
) {
  return requests
    .map(({ applicant, cardNumber }) => {
      const name = resolveUserDisplayName(applicant) || applicant.email;
      return `${name}\n${applicant.email}\nCard number: ${cardNumber}`;
    })
    .join("\n\n");
}

export async function sendTeacherCardAccessBatch({
  organizationId,
  staffUserId,
  recipientId,
  requestIds,
}: {
  organizationId: string;
  staffUserId: string;
  recipientId: string;
  requestIds: string[];
}) {
  const [recipient, requests] = await Promise.all([
    getStaffRecipient({ organizationId, userId: recipientId }),
    getBatchRequests({ organizationId, requestIds }),
  ]);
  const recipientName = resolveUserDisplayName(recipient) || recipient.email;

  await triggerEmail({
    to: recipient.email,
    subject: `IOIO Lab card access request - ${requests.length} people`,
    text: `Hi ${recipientName},\n\nThe following people are requesting IOIO Lab card access:\n\n${batchLines(
      requests
    )}\n\nPlease review and approve their access.\n\nIOIO Lab`,
  });

  const batch = await db.$transaction(async (tx) => {
    const created = await tx.cardAccessBatch.create({
      data: {
        organizationId,
        createdById: staffUserId,
        sentById: staffUserId,
        recipientId,
        recipientEmail: recipient.email,
        recipientName,
        sentAt: new Date(),
      },
      select: { id: true },
    });
    await tx.cardAccessRequest.updateMany({
      where: {
        organizationId,
        id: { in: requests.map(({ id }) => id) },
        status: CardAccessRequestStatus.WAITING_FOR_SUBMISSION,
      },
      data: {
        status: CardAccessRequestStatus.SUBMITTED,
        submittedAt: new Date(),
      },
    });
    await tx.cardAccessBatchRequest.createMany({
      data: requests.map(({ id }) => ({ batchId: created.id, requestId: id })),
    });
    return created;
  });

  return batch;
}

export async function addStaffCardAccessRequest({
  organizationId,
  applicantId,
  cardNumber,
  consentConfirmed,
}: {
  organizationId: string;
  applicantId: string;
  cardNumber: string;
  consentConfirmed: boolean;
}) {
  if (!consentConfirmed) {
    throw new ShelfError({
      cause: null,
      message: "Consent must be confirmed before adding this person.",
      label: "User",
      shouldBeCaptured: false,
      status: 400,
    });
  }
  const member = await db.userOrganization.findFirst({
    where: { organizationId, userId: applicantId },
    select: { userId: true },
  });
  if (!member) {
    throw new ShelfError({
      cause: null,
      message: "That person is not a member of this IOIO organization.",
      label: "User",
      shouldBeCaptured: false,
      status: 400,
    });
  }
  const normalizedCardNumber = validateCardNumber(cardNumber);
  const existing = await db.cardAccessRequest.findFirst({
    where: { organizationId, applicantId, status: { in: ACTIVE_STATUSES } },
    select: { id: true },
  });
  if (existing) {
    throw new ShelfError({
      cause: null,
      message: "This person is already waiting for card access.",
      label: "User",
      shouldBeCaptured: false,
      status: 409,
    });
  }
  try {
    return await db.cardAccessRequest.create({
      data: {
        organizationId,
        applicantId,
        cardNumber: normalizedCardNumber,
        consentConfirmedAt: new Date(),
      },
      select: { id: true },
    });
  } catch (cause) {
    if (
      typeof cause === "object" &&
      cause !== null &&
      "code" in cause &&
      cause.code === "P2002"
    ) {
      throw new ShelfError({
        cause,
        message: "This person is already waiting for card access.",
        label: "User",
        shouldBeCaptured: false,
        status: 409,
      });
    }
    throw cause;
  }
}

export async function updateStaffCardAccessRequest({
  organizationId,
  requestId,
  cardNumber,
}: {
  organizationId: string;
  requestId: string;
  cardNumber: string;
}) {
  const normalizedCardNumber = validateCardNumber(cardNumber);
  const result = await db.cardAccessRequest.updateMany({
    where: {
      organizationId,
      id: requestId,
      status: {
        in: [
          CardAccessRequestStatus.WAITING_FOR_SUBMISSION,
          CardAccessRequestStatus.NEEDS_ATTENTION,
        ],
      },
    },
    data: { cardNumber: normalizedCardNumber },
  });
  if (result.count !== 1) {
    throw new ShelfError({
      cause: null,
      message: "Only waiting requests can be updated.",
      label: "User",
      shouldBeCaptured: false,
    });
  }
}

export async function removeStaffCardAccessRequest({
  organizationId,
  requestId,
}: {
  organizationId: string;
  requestId: string;
}) {
  const result = await db.cardAccessRequest.updateMany({
    where: {
      organizationId,
      id: requestId,
      status: CardAccessRequestStatus.WAITING_FOR_SUBMISSION,
    },
    data: {
      status: CardAccessRequestStatus.CANCELLED,
      cancelledAt: new Date(),
    },
  });

  if (result.count !== 1) {
    throw new ShelfError({
      cause: null,
      message: "Only waiting requests can be removed.",
      label: "User",
      shouldBeCaptured: false,
      status: 409,
    });
  }
}

export async function markCardAccessNeedsAttention({
  organizationId,
  requestId,
}: {
  organizationId: string;
  requestId: string;
}) {
  await db.cardAccessRequest.updateMany({
    where: {
      organizationId,
      id: requestId,
      status: {
        in: [
          CardAccessRequestStatus.WAITING_FOR_SUBMISSION,
          CardAccessRequestStatus.SUBMITTED,
        ],
      },
    },
    data: { status: CardAccessRequestStatus.NEEDS_ATTENTION },
  });
}

export async function markCardAccessApproved({
  organizationId,
  requestId,
}: {
  organizationId: string;
  requestId: string;
}) {
  const result = await db.cardAccessRequest.updateMany({
    where: {
      organizationId,
      id: requestId,
      status: CardAccessRequestStatus.SUBMITTED,
    },
    data: { status: CardAccessRequestStatus.APPROVED, approvedAt: new Date() },
  });
  if (result.count !== 1) {
    throw new ShelfError({
      cause: null,
      message: "Only pending card access requests can be approved.",
      label: "User",
      shouldBeCaptured: false,
      status: 409,
    });
  }
}
