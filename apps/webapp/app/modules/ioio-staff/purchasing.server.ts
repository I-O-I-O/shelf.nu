import { randomUUID } from "node:crypto";
import {
  Currency,
  Prisma,
  PurchasePriority,
  PurchaseRequestStatus,
} from "@prisma/client";
import { db } from "~/database/db.server";
import { getSupabaseAdmin } from "~/integrations/supabase/client";
import { getAcademicYear } from "~/modules/ioio-lab-information/service.server";
import { getIoioArchivedItemIds } from "~/modules/ioio-staff/archive.server";
import { getSelectedOrganization } from "~/modules/organization/context.server";
import { ShelfError } from "~/utils/error";
import { createSignedUrl } from "~/utils/storage.server";
import { extractPdfTextForReceiptReview } from "./inventory-import.server";

export const PURCHASE_RECEIPT_MAX_BYTES = 5 * 1024 * 1024;
const RECEIPT_MIME_EXTENSIONS = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
} as const;

const PRIORITY_ORDER: Record<PurchasePriority, number> = {
  HIGH: 0,
  MEDIUM: 1,
  LATER: 2,
};
const PURCHASING_CURRENCY = Currency.SEK;

function purchasingError(message: string, status: 400 | 403 | 404 | 409 = 400) {
  return new ShelfError({
    cause: null,
    message,
    label: "Purchasing",
    status,
    shouldBeCaptured: false,
  });
}

export async function requirePurchasingAccess({
  userId,
  request,
}: {
  userId: string;
  request: Request;
}) {
  const selected = await getSelectedOrganization({ userId, request });
  const membership = selected.userOrganizations.find(
    (entry) => entry.organization.id === selected.organizationId
  );
  const isAdmin = Boolean(
    membership?.roles.some((role) => role === "ADMIN" || role === "OWNER")
  );
  const isIoioTA = Boolean(
    selected.organizationId &&
      (await db.ioioLabTA.findUnique({
        where: {
          organizationId_userId: {
            organizationId: selected.organizationId,
            userId,
          },
        },
        select: { id: true },
      }))
  );

  if (!selected.organizationId || (!isAdmin && !isIoioTA)) {
    throw purchasingError(
      "Purchasing is available to IOIO Staff and TAs only.",
      403
    );
  }

  return {
    organizationId: selected.organizationId,
    isAdmin,
    isIoioTA,
  };
}

export function parseAcademicYear(value: string | null, now = new Date()) {
  if (!value) return getAcademicYear(now);
  const match = /^(\d{4})-(\d{4})$/.exec(value);
  if (!match || Number(match[2]) !== Number(match[1]) + 1) {
    throw purchasingError("Choose a valid academic year.");
  }
  return value;
}

export async function getPurchasingDashboardSummary(
  organizationId: string,
  academicYear = getAcademicYear()
) {
  const budget = await db.annualBudget.findUnique({
    where: { organizationId_academicYear: { organizationId, academicYear } },
    select: { id: true, amount: true, accountingResetAt: true },
  });

  if (!budget) {
    return {
      academicYear,
      currency: PURCHASING_CURRENCY,
      budget: 0,
      spent: 0,
      openRequests: 0,
    };
  }

  const [spent, openRequests] = await Promise.all([
    db.purchase.aggregate({
      where: {
        organizationId,
        budgetId: budget.id,
        ...(budget.accountingResetAt
          ? { createdAt: { gte: budget.accountingResetAt } }
          : {}),
      },
      _sum: { actualTotal: true },
    }),
    db.purchaseRequest.count({
      where: {
        organizationId,
        budgetId: budget.id,
        status: { in: ["PLANNED", "RESERVED"] },
      },
    }),
  ]);

  return {
    academicYear,
    currency: PURCHASING_CURRENCY,
    budget: Number(budget.amount),
    spent: Number(spent._sum.actualTotal ?? 0),
    openRequests,
  };
}

function parseMoney(value: unknown, label: string, allowEmpty = false) {
  const raw =
    typeof value === "string" ? value.trim().replace(/[, ]/g, "") : "";
  if (!raw && allowEmpty) return null;
  if (!/^\d+(?:\.\d{1,2})?$/.test(raw)) {
    throw purchasingError(`${label} must be a valid non-negative amount.`);
  }
  const parsed = new Prisma.Decimal(raw);
  if (!parsed.isFinite() || parsed.greaterThan("999999999999.99")) {
    throw purchasingError(`${label} is outside the supported range.`);
  }
  return parsed;
}

function parseQuantity(value: unknown) {
  const quantity = Number(value);
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 100000) {
    throw purchasingError("Quantity must be a whole number greater than zero.");
  }
  return quantity;
}

function parseDate(value: unknown) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw purchasingError("Enter a valid purchase date.");
  }
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw purchasingError("Enter a valid purchase date.");
  }
  return date;
}

function parsePriority(value: unknown): PurchasePriority {
  if (value === "LOW") return PurchasePriority.LATER;
  if (Object.values(PurchasePriority).includes(value as PurchasePriority)) {
    return value as PurchasePriority;
  }
  throw purchasingError("Choose High, Medium, or Low priority.");
}

function getDateGuess(text: string) {
  const match =
    text.match(/\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/) ??
    text.match(/\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})\b/);
  if (!match) return null;
  const iso = match[0].replace(/[/.]/g, "-");
  if (/^\d{4}-/.test(iso)) return iso;
  const [day, month, year] = iso.split("-");
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

function getReceiptGuesses(text: string) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const date = getDateGuess(text);
  const totalLine = lines.find((line) =>
    /\b(total|amount due|to pay|summa)\b/i.test(line)
  );
  const amountMatch = totalLine?.match(
    /(?:\d[\d\s.,]*\d|\d)(?:\s?(?:SEK|EUR|USD|GBP|kr|€|\$))?/i
  );
  const rawAmount = amountMatch?.[0]
    ?.replace(/\s/g, "")
    .replace(/[A-Za-z€$]/g, "");
  const normalizedAmount = rawAmount
    ? rawAmount.includes(",") && !rawAmount.includes(".")
      ? rawAmount.replace(",", ".")
      : rawAmount.replace(/,(?=\d{3}(?:\D|$))/g, "")
    : null;
  const vendor = lines.find(
    (line) =>
      line.length > 1 &&
      line.length < 120 &&
      !/invoice|receipt|total|subtotal|vat|tax|date|invoice no/i.test(line)
  );
  return {
    vendor: vendor ?? "",
    purchaseDate: date ?? "",
    actualTotal:
      normalizedAmount && /^\d+(?:\.\d{1,2})?$/.test(normalizedAmount)
        ? normalizedAmount
        : "",
    items: [] as Array<{ name: string; quantity: number; lineTotal: string }>,
    extractionNote: text
      ? "A few receipt fields were suggested from readable PDF text. Review every value before saving."
      : "We couldn't reliably read this receipt. Enter the purchase details manually.",
  };
}

export async function getPurchasingPageData({
  organizationId,
  academicYear,
}: {
  organizationId: string;
  academicYear: string;
}) {
  const budget = await db.annualBudget.upsert({
    where: { organizationId_academicYear: { organizationId, academicYear } },
    create: {
      organizationId,
      academicYear,
      currency: PURCHASING_CURRENCY,
    },
    update: { currency: PURCHASING_CURRENCY },
    select: {
      id: true,
      academicYear: true,
      amount: true,
      currency: true,
      accountingResetAt: true,
    },
  });
  const archivedAssetIds = await getIoioArchivedItemIds({
    organizationId,
    itemType: "ASSET",
  });

  const [
    spentAggregate,
    reservedAggregate,
    requests,
    purchases,
    adjustments,
    budgets,
    assets,
  ] = await Promise.all([
    db.purchase.aggregate({
      where: {
        organizationId,
        budgetId: budget.id,
        ...(budget.accountingResetAt
          ? { createdAt: { gte: budget.accountingResetAt } }
          : {}),
      },
      _sum: { actualTotal: true },
    }),
    db.purchaseRequest.aggregate({
      where: { organizationId, budgetId: budget.id, status: "RESERVED" },
      _sum: { estimatedCost: true },
    }),
    db.purchaseRequest.findMany({
      where: {
        organizationId,
        budgetId: budget.id,
        status: { in: ["PLANNED", "RESERVED"] },
      },
      include: {
        requestedBy: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            displayName: true,
            email: true,
          },
        },
        purchase: { select: { id: true } },
      },
      orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
    }),
    db.purchase.findMany({
      where: {
        organizationId,
        budgetId: budget.id,
        removedFromPurchasedAt: null,
      },
      include: {
        purchaseRequest: { select: { title: true } },
        items: {
          include: {
            linkedAsset: {
              select: { id: true, title: true, type: true, assetModelId: true },
            },
          },
        },
        corrections: {
          include: {
            changedBy: {
              select: {
                firstName: true,
                lastName: true,
                displayName: true,
                email: true,
              },
            },
          },
          orderBy: { createdAt: "desc" },
        },
        createdBy: {
          select: {
            firstName: true,
            lastName: true,
            displayName: true,
            email: true,
          },
        },
      },
      orderBy: [{ purchaseDate: "desc" }, { createdAt: "desc" }],
    }),
    db.purchaseBudgetAdjustment.findMany({
      where: { budgetId: budget.id },
      include: {
        changedBy: {
          select: {
            firstName: true,
            lastName: true,
            displayName: true,
            email: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
    db.annualBudget.findMany({
      where: { organizationId },
      select: { id: true, academicYear: true, amount: true, currency: true },
      orderBy: { academicYear: "desc" },
    }),
    db.asset.findMany({
      where: {
        organizationId,
        status: "AVAILABLE",
        id: { notIn: archivedAssetIds },
      },
      select: {
        id: true,
        title: true,
        type: true,
        quantity: true,
        assetModelId: true,
      },
      orderBy: { title: "asc" },
      take: 250,
    }),
  ]);

  const receiptUrls = await Promise.all(
    purchases.map(async (purchase) =>
      purchase.receiptPath
        ? ([
            purchase.id,
            await createSignedUrl({ filename: purchase.receiptPath }),
          ] as const)
        : ([purchase.id, null] as const)
    )
  );
  const spent = spentAggregate._sum.actualTotal ?? new Prisma.Decimal(0);
  const reserved =
    reservedAggregate._sum.estimatedCost ?? new Prisma.Decimal(0);
  const available = new Prisma.Decimal(budget.amount)
    .minus(spent)
    .minus(reserved);
  const currentAcademicYear = getAcademicYear();
  const yearList = [
    ...new Set([
      currentAcademicYear,
      ...budgets.map((item) => item.academicYear),
    ]),
  ]
    .sort()
    .reverse();

  return {
    budget: {
      id: budget.id,
      academicYear: budget.academicYear,
      amount: budget.amount.toString(),
      spent: spent.toString(),
      reserved: reserved.toString(),
      available: available.toString(),
      currency: budget.currency,
    },
    requests: requests
      .sort(
        (left, right) =>
          PRIORITY_ORDER[left.priority] - PRIORITY_ORDER[right.priority] ||
          left.createdAt.getTime() - right.createdAt.getTime()
      )
      .map((request) => ({
        ...request,
        estimatedCost: request.estimatedCost?.toString() ?? null,
      })),
    purchases: purchases.map((purchase) => ({
      ...purchase,
      actualTotal: purchase.actualTotal.toString(),
      receiptUrl: new Map(receiptUrls).get(purchase.id) ?? null,
      items: purchase.items.map((item) => ({
        ...item,
        lineTotal: item.lineTotal?.toString() ?? null,
      })),
    })),
    adjustments: adjustments.map((adjustment) => ({
      ...adjustment,
      previousAmount: adjustment.previousAmount.toString(),
      newAmount: adjustment.newAmount.toString(),
    })),
    budgets: budgets.map((item) => ({
      ...item,
      amount: item.amount.toString(),
    })),
    years: yearList,
    assets,
  };
}

export async function updateAnnualBudget({
  organizationId,
  academicYear,
  userId,
  amount,
  reason,
  confirmedOverBudget = false,
}: {
  organizationId: string;
  academicYear: string;
  userId: string;
  amount: unknown;
  reason: unknown;
  confirmedOverBudget?: boolean;
}) {
  const newAmount = parseMoney(amount, "Annual budget")!;
  const reasonText =
    String(reason ?? "")
      .trim()
      .slice(0, 1000) || null;
  const current = await db.annualBudget.findUnique({
    where: { organizationId_academicYear: { organizationId, academicYear } },
    select: { id: true, accountingResetAt: true },
  });
  if (current) {
    const [spent, reservedRows] = await Promise.all([
      db.purchase.aggregate({
        where: {
          organizationId,
          budgetId: current.id,
          ...(current.accountingResetAt
            ? { createdAt: { gte: current.accountingResetAt } }
            : {}),
        },
        _sum: { actualTotal: true },
      }),
      db.purchaseRequest.findMany({
        where: { organizationId, budgetId: current.id, status: "RESERVED" },
        select: { estimatedCost: true },
      }),
    ]);
    const committed = new Prisma.Decimal(spent._sum.actualTotal ?? 0).plus(
      sumReserved(reservedRows)
    );
    if (newAmount.lessThan(committed) && !confirmedOverBudget) {
      throw purchasingError(
        `This budget change will leave ${committed
          .minus(newAmount)
          .toFixed(
            2
          )} in confirmed spending or reservations above the annual budget. Confirm to continue.`,
        409
      );
    }
  }
  return db.$transaction(async (tx) => {
    const existing = await tx.annualBudget.findUnique({
      where: { organizationId_academicYear: { organizationId, academicYear } },
      select: { id: true, amount: true },
    });
    const budget = existing
      ? await tx.annualBudget.update({
          where: { id: existing.id, organizationId },
          data: { amount: newAmount },
        })
      : await tx.annualBudget.create({
          data: {
            organizationId,
            academicYear,
            currency: PURCHASING_CURRENCY,
            amount: newAmount,
          },
        });
    if (existing && !new Prisma.Decimal(existing.amount).equals(newAmount)) {
      await tx.purchaseBudgetAdjustment.create({
        data: {
          budgetId: budget.id,
          previousAmount: existing.amount,
          newAmount,
          reason: reasonText,
          changedByUserId: userId,
        },
      });
    }
    return budget;
  });
}

/** Reset the live financial totals while keeping request and purchase history intact. */
export async function resetAnnualBudget({
  organizationId,
  budgetId,
  userId,
}: {
  organizationId: string;
  budgetId: string;
  userId: string;
}) {
  return db.$transaction(async (tx) => {
    const budget = await tx.annualBudget.findFirst({
      where: { id: budgetId, organizationId },
      select: { id: true, amount: true },
    });
    if (!budget)
      throw purchasingError("That annual budget could not be found.", 404);

    const now = new Date();
    await tx.annualBudget.update({
      where: { id: budget.id, organizationId },
      data: { amount: new Prisma.Decimal(0), accountingResetAt: now },
    });
    await tx.purchaseRequest.updateMany({
      where: {
        organizationId,
        budgetId,
        status: PurchaseRequestStatus.RESERVED,
      },
      data: { status: PurchaseRequestStatus.PLANNED },
    });
    await tx.purchaseBudgetAdjustment.create({
      data: {
        budgetId,
        previousAmount: budget.amount,
        newAmount: new Prisma.Decimal(0),
        reason: "Budget reset",
        changedByUserId: userId,
      },
    });
  });
}

export async function createPurchaseRequest({
  organizationId,
  budgetId,
  userId,
  title,
  quantity,
  estimatedCost,
  priority,
  note,
  link,
  reserveBudget = false,
  confirmedOverBudget = false,
}: {
  organizationId: string;
  budgetId: string;
  userId: string;
  title: unknown;
  quantity: unknown;
  estimatedCost: unknown;
  priority: unknown;
  note: unknown;
  link: unknown;
  reserveBudget?: boolean;
  confirmedOverBudget?: boolean;
}) {
  const titleText = String(title ?? "").trim();
  if (!titleText || titleText.length > 240)
    throw purchasingError("Enter a purchase item name (up to 240 characters).");
  const parsedLink = String(link ?? "").trim();
  if (parsedLink) {
    try {
      if (!["http:", "https:"].includes(new URL(parsedLink).protocol))
        throw new Error();
    } catch {
      throw purchasingError("Enter a valid http or https link.");
    }
  }
  const parsedEstimatedCost = parseMoney(
    estimatedCost,
    "Estimated total",
    true
  );
  if (reserveBudget) {
    if (!parsedEstimatedCost) {
      throw purchasingError(
        "Enter an estimated total before reserving budget."
      );
    }
    await checkBudgetOverage({
      organizationId,
      budgetId,
      amount: parsedEstimatedCost,
      confirmed: confirmedOverBudget,
    });
  }
  return db.purchaseRequest.create({
    data: {
      organizationId,
      budgetId,
      requestedByUserId: userId,
      title: titleText,
      quantity: parseQuantity(quantity),
      estimatedCost: parsedEstimatedCost,
      priority: parsePriority(priority),
      status: reserveBudget
        ? PurchaseRequestStatus.RESERVED
        : PurchaseRequestStatus.PLANNED,
      note:
        String(note ?? "")
          .trim()
          .slice(0, 2000) || null,
      link: parsedLink || null,
    },
  });
}

export async function updatePurchaseRequest({
  organizationId,
  requestId,
  title,
  quantity,
  estimatedCost,
  priority,
  note,
  link,
  reserveBudget,
  confirmedOverBudget = false,
}: {
  organizationId: string;
  requestId: string;
  title: unknown;
  quantity: unknown;
  estimatedCost: unknown;
  priority: unknown;
  note: unknown;
  link: unknown;
  reserveBudget: boolean;
  confirmedOverBudget?: boolean;
}) {
  const existing = await db.purchaseRequest.findFirst({
    where: {
      id: requestId,
      organizationId,
      status: { in: ["PLANNED", "RESERVED"] },
    },
  });
  if (!existing)
    throw purchasingError("That planned purchase could not be found.", 404);
  const titleText = String(title ?? "").trim();
  if (!titleText || titleText.length > 240)
    throw purchasingError("Enter a purchase item name (up to 240 characters).");
  const linkText = String(link ?? "").trim();
  if (linkText) {
    try {
      if (!["http:", "https:"].includes(new URL(linkText).protocol))
        throw new Error();
    } catch {
      throw purchasingError("Enter a valid http or https link.");
    }
  }
  const parsedEstimatedCost = parseMoney(
    estimatedCost,
    "Estimated total",
    true
  );
  if (reserveBudget) {
    if (!parsedEstimatedCost) {
      throw purchasingError(
        "Add an estimated cost before reserving budget for this purchase."
      );
    }
    await checkBudgetOverage({
      organizationId,
      budgetId: existing.budgetId,
      requestId: existing.id,
      amount: parsedEstimatedCost,
      confirmed: confirmedOverBudget,
    });
  }
  return db.purchaseRequest.update({
    where: { id: existing.id, organizationId },
    data: {
      title: titleText,
      quantity: parseQuantity(quantity),
      estimatedCost: parsedEstimatedCost,
      priority: parsePriority(priority),
      status: reserveBudget
        ? PurchaseRequestStatus.RESERVED
        : PurchaseRequestStatus.PLANNED,
      note:
        String(note ?? "")
          .trim()
          .slice(0, 2000) || null,
      link: linkText || null,
    },
  });
}

export async function setPurchaseRequestStatus({
  organizationId,
  requestId,
  status,
  confirmedOverBudget = false,
}: {
  organizationId: string;
  requestId: string;
  status: PurchaseRequestStatus;
  confirmedOverBudget?: boolean;
}) {
  const existing = await db.purchaseRequest.findFirst({
    where: {
      id: requestId,
      organizationId,
      status: { in: ["PLANNED", "RESERVED"] },
    },
  });
  if (!existing)
    throw purchasingError("That planned purchase could not be found.", 404);
  if (status === "PURCHASED")
    throw purchasingError(
      "Record the actual purchase details to mark this item purchased."
    );
  if (status === "RESERVED" && existing.status !== "RESERVED") {
    if (!existing.estimatedCost)
      throw purchasingError("Add an estimated cost before reserving budget.");
    await checkBudgetOverage({
      organizationId,
      budgetId: existing.budgetId,
      requestId: existing.id,
      amount: existing.estimatedCost,
      confirmed: confirmedOverBudget,
    });
  }
  return db.purchaseRequest.update({
    where: { id: existing.id, organizationId },
    data: { status },
  });
}

type PurchaseLineInput = {
  name: string;
  quantity: number;
  lineTotal?: string | number | null;
  linkedAssetId?: string | null;
};
function parsePurchaseItems(items: unknown): PurchaseLineInput[] {
  if (!Array.isArray(items) || items.length > 100)
    throw purchasingError("Add between one and 100 purchase lines.");
  return items.map((item) => {
    if (!item || typeof item !== "object")
      throw purchasingError("A purchase line is invalid.");
    const row = item as Record<string, unknown>;
    const name = String(row.name ?? "").trim();
    if (!name || name.length > 240)
      throw purchasingError("Each purchase line needs a name.");
    const lineTotal = parseMoney(row.lineTotal, "Line total", true);
    return {
      name,
      quantity: parseQuantity(row.quantity),
      lineTotal: lineTotal?.toString() ?? null,
      linkedAssetId: String(row.linkedAssetId ?? "").trim() || null,
    };
  });
}

async function ensureLinkedAssetsBelongToOrganization(
  organizationId: string,
  items: PurchaseLineInput[]
) {
  const ids = [
    ...new Set(
      items.flatMap((item) => (item.linkedAssetId ? [item.linkedAssetId] : []))
    ),
  ];
  if (!ids.length) return;
  const count = await db.asset.count({
    where: { organizationId, id: { in: ids } },
  });
  if (count !== ids.length)
    throw purchasingError("Choose an inventory item from this organization.");
}

function sumReserved(rows: Array<{ estimatedCost: Prisma.Decimal | null }>) {
  return rows.reduce(
    (sum, row) => sum.plus(row.estimatedCost ?? 0),
    new Prisma.Decimal(0)
  );
}

async function checkBudgetOverage({
  organizationId,
  budgetId,
  requestId,
  amount,
  confirmed,
}: {
  organizationId: string;
  budgetId: string;
  requestId?: string | null;
  amount: Prisma.Decimal;
  confirmed: boolean;
}) {
  const budget = await db.annualBudget.findFirstOrThrow({
    where: { id: budgetId, organizationId },
    select: { amount: true, accountingResetAt: true },
  });
  const [spent, reservedRows] = await Promise.all([
    db.purchase.aggregate({
      where: {
        organizationId,
        budgetId,
        ...(budget.accountingResetAt
          ? { createdAt: { gte: budget.accountingResetAt } }
          : {}),
      },
      _sum: { actualTotal: true },
    }),
    db.purchaseRequest.findMany({
      where: {
        organizationId,
        budgetId,
        status: "RESERVED",
        ...(requestId ? { id: { not: requestId } } : {}),
      },
      select: { estimatedCost: true },
    }),
  ]);
  const available = new Prisma.Decimal(budget.amount)
    .minus(spent._sum.actualTotal ?? 0)
    .minus(sumReserved(reservedRows));
  const resultingAvailable = available.minus(amount);
  if (resultingAvailable.isNegative() && !confirmed) {
    throw purchasingError(
      `This will exceed the current annual budget by ${resultingAvailable
        .abs()
        .toFixed(2)}. Confirm to continue.`,
      409
    );
  }
}

export async function recordPurchase({
  organizationId,
  budgetId,
  userId,
  requestId,
  vendor,
  purchaseDate,
  actualTotal,
  note,
  items,
  receiptDraftId,
  confirmedOverBudget,
}: {
  organizationId: string;
  budgetId: string;
  userId: string;
  requestId?: string | null;
  vendor: unknown;
  purchaseDate: unknown;
  actualTotal: unknown;
  note: unknown;
  items: unknown;
  receiptDraftId?: string | null;
  confirmedOverBudget: boolean;
}) {
  const total = parseMoney(actualTotal, "Actual total")!;
  const parsedDate = parseDate(purchaseDate);
  const lines = parsePurchaseItems(items);
  await ensureLinkedAssetsBelongToOrganization(organizationId, lines);
  await checkBudgetOverage({
    organizationId,
    budgetId,
    requestId,
    amount: total,
    confirmed: confirmedOverBudget,
  });
  let receipt: {
    receiptPath: string;
    originalName: string;
    mimeType: string;
    size: number;
  } | null = null;
  if (receiptDraftId) {
    receipt = await db.purchaseReceiptDraft.findFirst({
      where: {
        id: receiptDraftId,
        organizationId,
        uploadedByUserId: userId,
        expiresAt: { gt: new Date() },
      },
      select: {
        receiptPath: true,
        originalName: true,
        mimeType: true,
        size: true,
      },
    });
    if (!receipt)
      throw purchasingError(
        "The uploaded receipt expired. Upload it again.",
        404
      );
  }
  return db.$transaction(async (tx) => {
    if (requestId) {
      const planned = await tx.purchaseRequest.findFirst({
        where: {
          id: requestId,
          organizationId,
          budgetId,
          status: { in: ["PLANNED", "RESERVED"] },
        },
      });
      if (!planned)
        throw purchasingError(
          "This purchase plan is no longer available.",
          409
        );
    }
    const purchase = await tx.purchase.create({
      data: {
        organizationId,
        budgetId,
        purchaseRequestId: requestId || null,
        createdByUserId: userId,
        vendor:
          String(vendor ?? "")
            .trim()
            .slice(0, 240) || null,
        purchaseDate: parsedDate,
        actualTotal: total,
        note:
          String(note ?? "")
            .trim()
            .slice(0, 2000) || null,
        ...(receipt
          ? {
              receiptPath: receipt.receiptPath,
              receiptOriginalName: receipt.originalName,
              receiptMimeType: receipt.mimeType,
              receiptSize: receipt.size,
            }
          : {}),
        items: {
          create: lines.map((line) => ({
            name: line.name,
            quantity: line.quantity,
            lineTotal: line.lineTotal,
            linkedAssetId: line.linkedAssetId,
          })),
        },
      },
    });
    if (requestId)
      await tx.purchaseRequest.update({
        where: { id: requestId, organizationId, budgetId },
        data: { status: "PURCHASED" },
      });
    if (receiptDraftId)
      await tx.purchaseReceiptDraft.deleteMany({
        where: { id: receiptDraftId, organizationId, uploadedByUserId: userId },
      });
    return purchase;
  });
}

type BulkPurchaseResult = {
  recorded: Array<{ id: string; title: string }>;
  failed: Array<{ id: string; title: string; reason: string }>;
};

/**
 * Records several planned purchases from one form submission. Each purchase is
 * committed independently so a stale/ineligible request does not roll back
 * the other valid rows. A shared receipt draft is attached to every successful
 * purchase and consumed once after processing.
 */
export async function recordPlannedPurchases({
  organizationId,
  budgetId,
  userId,
  purchaseLines,
  purchaseDate,
  receiptDraftId,
  confirmedOverBudget,
}: {
  organizationId: string;
  budgetId: string;
  userId: string;
  purchaseLines: unknown;
  purchaseDate: unknown;
  receiptDraftId?: string | null;
  confirmedOverBudget: boolean;
}): Promise<BulkPurchaseResult> {
  if (
    !Array.isArray(purchaseLines) ||
    purchaseLines.length < 1 ||
    purchaseLines.length > 100
  ) {
    throw purchasingError("Select between one and 100 planned purchases.");
  }
  const parsedDate = parseDate(purchaseDate);
  const parsedLines = purchaseLines.map((value) => {
    if (!value || typeof value !== "object") {
      throw purchasingError("A planned purchase selection is invalid.");
    }
    const row = value as Record<string, unknown>;
    const requestId = String(row.requestId ?? "").trim();
    if (!requestId) throw purchasingError("A planned purchase is missing.");
    return { requestId };
  });
  if (
    new Set(parsedLines.map((line) => line.requestId)).size !==
    parsedLines.length
  ) {
    throw purchasingError("A planned purchase was selected more than once.");
  }

  let receipt: {
    receiptPath: string;
    originalName: string;
    mimeType: string;
    size: number;
  } | null = null;
  if (receiptDraftId) {
    receipt = await db.purchaseReceiptDraft.findFirst({
      where: {
        id: receiptDraftId,
        organizationId,
        uploadedByUserId: userId,
        expiresAt: { gt: new Date() },
      },
      select: {
        receiptPath: true,
        originalName: true,
        mimeType: true,
        size: true,
      },
    });
    if (!receipt) {
      throw purchasingError(
        "The uploaded receipt expired. Upload it again.",
        404
      );
    }
  }

  const requestedIds = parsedLines.map((line) => line.requestId);
  const requests = await db.purchaseRequest.findMany({
    where: { id: { in: requestedIds }, organizationId, budgetId },
    select: {
      id: true,
      title: true,
      quantity: true,
      status: true,
      estimatedCost: true,
      purchase: { select: { id: true } },
    },
  });
  const requestById = new Map(requests.map((request) => [request.id, request]));
  const recorded: BulkPurchaseResult["recorded"] = [];
  const failed: BulkPurchaseResult["failed"] = [];
  const eligibleLines: Array<{
    requestId: string;
    actualTotal: Prisma.Decimal;
  }> = [];

  for (const line of parsedLines) {
    const request = requestById.get(line.requestId);
    if (!request) {
      failed.push({
        id: line.requestId,
        title: "Planned purchase",
        reason: "not found in this budget year",
      });
    } else if (
      (request.status !== PurchaseRequestStatus.PLANNED &&
        request.status !== PurchaseRequestStatus.RESERVED) ||
      request.purchase
    ) {
      failed.push({
        id: request.id,
        title: request.title,
        reason: "already purchased or no longer planned",
      });
    } else if (request.estimatedCost === null) {
      failed.push({
        id: request.id,
        title: request.title,
        reason: "no estimated price has been set",
      });
    } else {
      eligibleLines.push({
        ...line,
        actualTotal: new Prisma.Decimal(request.estimatedCost),
      });
    }
  }

  if (eligibleLines.length) {
    const eligibleIds = eligibleLines.map((line) => line.requestId);
    const budget = await db.annualBudget.findFirstOrThrow({
      where: { id: budgetId, organizationId },
      select: { amount: true, accountingResetAt: true },
    });
    const [spent, reservationsOutsideSelection] = await Promise.all([
      db.purchase.aggregate({
        where: {
          organizationId,
          budgetId,
          ...(budget.accountingResetAt
            ? { createdAt: { gte: budget.accountingResetAt } }
            : {}),
        },
        _sum: { actualTotal: true },
      }),
      db.purchaseRequest.findMany({
        where: {
          organizationId,
          budgetId,
          status: PurchaseRequestStatus.RESERVED,
          id: { notIn: eligibleIds },
        },
        select: { estimatedCost: true },
      }),
    ]);
    const totalActual = eligibleLines.reduce(
      (sum, line) => sum.plus(line.actualTotal),
      new Prisma.Decimal(0)
    );
    const projectedAvailable = new Prisma.Decimal(budget.amount)
      .minus(spent._sum.actualTotal ?? 0)
      .minus(sumReserved(reservationsOutsideSelection))
      .minus(totalActual);
    if (projectedAvailable.isNegative() && !confirmedOverBudget) {
      throw purchasingError(
        `These purchases will exceed the current annual budget by ${projectedAvailable
          .abs()
          .toFixed(2)}. Confirm to continue.`,
        409
      );
    }
  }

  for (const line of eligibleLines) {
    const request = requestById.get(line.requestId)!;
    try {
      await db.$transaction(async (tx) => {
        const updated = await tx.purchaseRequest.updateMany({
          where: {
            id: request.id,
            organizationId,
            budgetId,
            status: {
              in: [
                PurchaseRequestStatus.PLANNED,
                PurchaseRequestStatus.RESERVED,
              ],
            },
            purchase: { is: null },
          },
          data: { status: PurchaseRequestStatus.PURCHASED },
        });
        if (updated.count !== 1) {
          throw purchasingError("already purchased or no longer planned", 409);
        }
        await tx.purchase.create({
          data: {
            organizationId,
            budgetId,
            purchaseRequestId: request.id,
            createdByUserId: userId,
            purchaseDate: parsedDate,
            actualTotal: line.actualTotal,
            ...(receipt
              ? {
                  receiptPath: receipt.receiptPath,
                  receiptOriginalName: receipt.originalName,
                  receiptMimeType: receipt.mimeType,
                  receiptSize: receipt.size,
                }
              : {}),
            items: {
              create: {
                name: request.title,
                quantity: request.quantity,
                lineTotal: line.actualTotal,
              },
            },
          },
          select: { id: true },
        });
      });
      recorded.push({ id: request.id, title: request.title });
    } catch (cause) {
      if (cause instanceof ShelfError) {
        failed.push({
          id: request.id,
          title: request.title,
          reason: cause.message,
        });
      } else if (
        cause instanceof Prisma.PrismaClientKnownRequestError &&
        cause.code === "P2002"
      ) {
        failed.push({
          id: request.id,
          title: request.title,
          reason: "already purchased",
        });
      } else {
        throw cause;
      }
    }
  }

  if (receiptDraftId && recorded.length) {
    await db.purchaseReceiptDraft.deleteMany({
      where: { id: receiptDraftId, organizationId, uploadedByUserId: userId },
    });
  }
  return { recorded, failed };
}

export async function setPurchaseRequestsStatus({
  organizationId,
  budgetId,
  requestIds,
  status,
  confirmedOverBudget,
}: {
  organizationId: string;
  budgetId: string;
  requestIds: unknown;
  status: "PLANNED" | "RESERVED";
  confirmedOverBudget: boolean;
}) {
  if (
    !Array.isArray(requestIds) ||
    requestIds.length < 1 ||
    requestIds.length > 100 ||
    requestIds.some((id) => typeof id !== "string" || !id.trim())
  ) {
    throw purchasingError("Select planned purchases to update.");
  }
  const ids = [...new Set(requestIds as string[])];
  const requests = await db.purchaseRequest.findMany({
    where: {
      id: { in: ids },
      organizationId,
      budgetId,
      status: {
        in: [PurchaseRequestStatus.PLANNED, PurchaseRequestStatus.RESERVED],
      },
    },
    select: { id: true, status: true, estimatedCost: true },
  });
  const applicable = requests.filter((request) => request.status !== status);
  if (!applicable.length) {
    throw purchasingError("No selected purchases need that budget update.");
  }
  if (status === PurchaseRequestStatus.RESERVED) {
    if (applicable.some((request) => !request.estimatedCost)) {
      throw purchasingError("Add an estimated total before reserving budget.");
    }
    const budget = await db.annualBudget.findFirstOrThrow({
      where: { id: budgetId, organizationId },
      select: { amount: true, accountingResetAt: true },
    });
    const [spent, existingReservations] = await Promise.all([
      db.purchase.aggregate({
        where: {
          organizationId,
          budgetId,
          ...(budget.accountingResetAt
            ? { createdAt: { gte: budget.accountingResetAt } }
            : {}),
        },
        _sum: { actualTotal: true },
      }),
      db.purchaseRequest.findMany({
        where: {
          organizationId,
          budgetId,
          status: PurchaseRequestStatus.RESERVED,
          id: { notIn: applicable.map((request) => request.id) },
        },
        select: { estimatedCost: true },
      }),
    ]);
    const amountToReserve = applicable.reduce(
      (sum, request) => sum.plus(request.estimatedCost ?? 0),
      new Prisma.Decimal(0)
    );
    const projectedAvailable = new Prisma.Decimal(budget.amount)
      .minus(spent._sum.actualTotal ?? 0)
      .minus(sumReserved(existingReservations))
      .minus(amountToReserve);
    if (projectedAvailable.isNegative() && !confirmedOverBudget) {
      throw purchasingError(
        `These reservations will exceed the current annual budget by ${projectedAvailable
          .abs()
          .toFixed(2)}. Confirm to continue.`,
        409
      );
    }
  }
  const result = await db.purchaseRequest.updateMany({
    where: {
      id: { in: applicable.map((request) => request.id) },
      organizationId,
      budgetId,
      status: {
        in: [PurchaseRequestStatus.PLANNED, PurchaseRequestStatus.RESERVED],
      },
    },
    data: { status },
  });
  return { updatedCount: result.count };
}

export async function correctPurchase({
  organizationId,
  purchaseId,
  userId,
  vendor,
  purchaseDate,
  actualTotal,
  note,
  items,
  reason,
  confirmedOverBudget,
}: {
  organizationId: string;
  purchaseId: string;
  userId: string;
  vendor: unknown;
  purchaseDate: unknown;
  actualTotal: unknown;
  note: unknown;
  items: unknown;
  reason: unknown;
  confirmedOverBudget: boolean;
}) {
  const total = parseMoney(actualTotal, "Actual total")!;
  const lines = parsePurchaseItems(items);
  await ensureLinkedAssetsBelongToOrganization(organizationId, lines);
  const existing = await db.purchase.findFirst({
    where: { id: purchaseId, organizationId },
  });
  if (!existing)
    throw purchasingError("That purchase could not be found.", 404);
  const delta = total.minus(existing.actualTotal);
  if (delta.greaterThan(0))
    await checkBudgetOverage({
      organizationId,
      budgetId: existing.budgetId,
      amount: delta,
      confirmed: confirmedOverBudget,
    });
  return db.$transaction(async (tx) => {
    await tx.purchaseCorrection.create({
      data: {
        purchaseId,
        previousTotal: existing.actualTotal,
        newTotal: total,
        reason:
          String(reason ?? "")
            .trim()
            .slice(0, 1000) || null,
        changedByUserId: userId,
      },
    });
    await tx.purchaseItem.deleteMany({ where: { purchaseId } });
    return tx.purchase.update({
      where: { id: purchaseId, organizationId },
      data: {
        vendor:
          String(vendor ?? "")
            .trim()
            .slice(0, 240) || null,
        purchaseDate: parseDate(purchaseDate),
        actualTotal: total,
        note:
          String(note ?? "")
            .trim()
            .slice(0, 2000) || null,
        items: {
          create: lines.map((line) => ({
            name: line.name,
            quantity: line.quantity,
            lineTotal: line.lineTotal,
            linkedAssetId: line.linkedAssetId,
          })),
        },
      },
    });
  });
}

/** Hide a recorded purchase from the Purchased list while retaining its spend record. */
export async function removePurchaseFromPurchased({
  organizationId,
  budgetId,
  purchaseId,
}: {
  organizationId: string;
  budgetId: string;
  purchaseId: string;
}) {
  const result = await db.purchase.updateMany({
    where: {
      id: purchaseId,
      organizationId,
      budgetId,
      removedFromPurchasedAt: null,
    },
    data: { removedFromPurchasedAt: new Date() },
  });
  if (result.count !== 1)
    throw purchasingError("That purchased record could not be found.", 404);
}

export async function linkPurchaseItemToAsset({
  organizationId,
  itemId,
  assetId,
}: {
  organizationId: string;
  itemId: string;
  assetId: string;
}) {
  const item = await db.purchaseItem.findFirst({
    where: { id: itemId, purchase: { organizationId } },
    select: { id: true },
  });
  if (!item)
    throw purchasingError("That purchased item could not be found.", 404);
  const asset = await db.asset.findFirst({
    where: { id: assetId, organizationId },
    select: { id: true },
  });
  if (!asset)
    throw purchasingError("Choose an inventory item from this organization.");
  return db.purchaseItem.update({
    where: { id: itemId },
    data: { linkedAssetId: assetId },
  });
}

export async function uploadPurchaseReceipt({
  organizationId,
  userId,
  academicYear,
  file,
}: {
  organizationId: string;
  userId: string;
  academicYear: string;
  file: File;
}) {
  const extension =
    RECEIPT_MIME_EXTENSIONS[file.type as keyof typeof RECEIPT_MIME_EXTENSIONS];
  if (!extension) throw purchasingError("Upload a PDF, JPG, or PNG receipt.");
  if (!file.size || file.size > PURCHASE_RECEIPT_MAX_BYTES)
    throw purchasingError("Receipt files must be smaller than 5 MB.");
  const path = `${organizationId}/purchasing/${academicYear}/${randomUUID()}.${extension}`;
  const bytes = Buffer.from(await file.arrayBuffer());
  const { error } = await getSupabaseAdmin()
    .storage.from("assets")
    .upload(path, bytes, {
      contentType: file.type,
      upsert: false,
    });
  if (error)
    throw purchasingError(
      "The receipt could not be uploaded. Please try again."
    );

  try {
    let extractedData: ReturnType<typeof getReceiptGuesses> | null = null;
    if (file.type === "application/pdf") {
      const text = extractPdfTextForReceiptReview(bytes);
      extractedData = getReceiptGuesses(text);
    }
    return await db.purchaseReceiptDraft.create({
      data: {
        organizationId,
        uploadedByUserId: userId,
        receiptPath: path,
        originalName:
          file.name.replace(/[\\/\0]/g, "_").slice(0, 255) ||
          `receipt.${extension}`,
        mimeType: file.type,
        size: file.size,
        extractedData: extractedData as Prisma.InputJsonValue | undefined,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });
  } catch (cause) {
    await getSupabaseAdmin().storage.from("assets").remove([path]);
    throw cause;
  }
}

export async function getReceiptDraft({
  organizationId,
  userId,
  draftId,
}: {
  organizationId: string;
  userId: string;
  draftId: string;
}) {
  const draft = await db.purchaseReceiptDraft.findFirst({
    where: {
      id: draftId,
      organizationId,
      uploadedByUserId: userId,
      expiresAt: { gt: new Date() },
    },
  });
  if (!draft) return null;
  return {
    ...draft,
    signedUrl: await createSignedUrl({ filename: draft.receiptPath }),
    extractedData:
      draft.extractedData &&
      typeof draft.extractedData === "object" &&
      !Array.isArray(draft.extractedData)
        ? (draft.extractedData as ReturnType<typeof getReceiptGuesses>)
        : null,
  };
}

export function isPurchasingPriority(value: string): value is PurchasePriority {
  return Object.values(PurchasePriority).includes(value as PurchasePriority);
}

export function isPurchaseRequestStatus(
  value: string
): value is PurchaseRequestStatus {
  return Object.values(PurchaseRequestStatus).includes(
    value as PurchaseRequestStatus
  );
}

export function isCurrency(value: string): value is Currency {
  return Object.values(Currency).includes(value as Currency);
}
