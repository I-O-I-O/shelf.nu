import { useCallback, useEffect, useRef, useState } from "react";
import {
  data,
  Link,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
  type MetaFunction,
  useFetcher,
  useLoaderData,
  useRouteLoaderData,
} from "react-router";
import { z } from "zod";
import { QuantityStepper } from "~/components/ioio/quantity-stepper";
import {
  BorrowSuccess,
  type BorrowCompletionItem,
} from "~/components/ioio-student/borrow-success";
import {
  useStudentCheckout,
  type StudentCheckoutItem,
} from "~/components/ioio-student/checkout-context";
import {
  SectionHeading,
  StudentAssetPlaceholder,
} from "~/components/ioio-student/student-ui";
import { CodeScanner } from "~/components/scanner/code-scanner";
import { db } from "~/database/db.server";
import { getPhysicalUnitLabelFromTitle } from "~/modules/asset/physical-unit";
import { resolveAssetImagesForPresentation } from "~/modules/asset/service.server";
import {
  borrowItem,
  acknowledgeBorrowItemStaffReservation,
  acknowledgePreparationStaffReservation,
  cancelBorrowItem,
  getBorrowItemAvailability,
  prepareBorrowItem,
  requestPreparationForItem,
  resolvePhysicalUnitNumber,
  type PreparedBorrowProposal,
} from "~/modules/ioio-student/borrow-item.server";
import { requireIoioBorrowerAccess } from "~/modules/ioio-student/route.server";
import { getIoioPhysicalUnitDisplayName } from "~/modules/kit/ioio-kit-presentation";
import { normalizeQrScanValue } from "~/modules/qr/normalize-scan-value";
import type { loader as layoutLoader } from "~/routes/_layout+/_layout";
import { makeShelfError } from "~/utils/error";
import { payload } from "~/utils/http.server";

export const meta: MetaFunction<typeof loader> = () => [
  { title: "Borrowing list" },
];

const checkoutActionSchema = z.discriminatedUnion("intent", [
  z.object({
    intent: z.literal("availability"),
    assetId: z.string().min(1),
    candidateAssetIds: z.string().optional(),
  }),
  z.object({
    intent: z.literal("resolve-qr"),
    assetId: z.string().min(1),
    candidateAssetIds: z.string().optional(),
    qrId: z.string().min(1),
  }),
  z.object({
    intent: z.literal("prepare"),
    assetId: z.string().min(1),
    candidateAssetIds: z.string().optional(),
    quantity: z.coerce.number().int().min(1),
    borrowMode: z.enum(["STANDARD", "I_HAVE_ITEM"]).optional(),
    scannedAssetId: z.string().optional(),
    scannedQrId: z.string().optional(),
    scannedAssetIds: z.string().optional(),
    scannedQrIds: z.string().optional(),
  }),
  z.object({
    intent: z.literal("request-preparation"),
    assetId: z.string().min(1),
    candidateAssetIds: z.string().optional(),
    quantity: z.coerce.number().int().min(1),
    submissionToken: z.string().uuid().optional(),
    reservationAcknowledgementToken: z.string().uuid().optional(),
  }),
  z.object({
    intent: z.literal("acknowledge-preparation-reservation"),
    assetId: z.string().min(1),
    candidateAssetIds: z.string().optional(),
    quantity: z.coerce.number().int().min(1),
  }),
  z.object({
    intent: z.literal("confirm"),
    confirmationToken: z.string().min(1),
    quantity: z.coerce.number().int().min(1),
    selectedPhysicalUnitIds: z.string().optional(),
  }),
  z.object({
    intent: z.literal("acknowledge-reservation"),
    confirmationToken: z.string().min(1),
  }),
  z.object({
    intent: z.literal("confirm-all"),
    proposals: z.string().min(2),
  }),
  z.object({
    intent: z.literal("refresh-images"),
    assetIds: z.string().min(1),
  }),
  z.object({
    intent: z.literal("cancel"),
    confirmationToken: z.string().min(1),
  }),
]);

const confirmAllProposalSchema = z
  .array(
    z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("borrow"),
        itemId: z.string().min(1),
        confirmationToken: z.string().min(1),
        quantity: z.number().int().min(1),
        selectedPhysicalUnitIds: z.array(z.string()).optional(),
      }),
      z.object({
        kind: z.literal("preparation"),
        itemId: z.string().min(1),
        assetId: z.string().min(1),
        candidateAssetIds: z.array(z.string().min(1)).optional(),
        quantity: z.number().int().min(1),
        submissionToken: z.string().uuid(),
        reservationAcknowledgementToken: z.string().uuid().optional(),
      }),
    ])
  )
  .superRefine((proposals, ctx) => {
    const seen = new Set<string>();
    proposals.forEach((proposal, index) => {
      if (seen.has(proposal.itemId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, "itemId"],
          message: "Each borrowing-list item can only be submitted once.",
        });
      }
      seen.add(proposal.itemId);
    });
  });

export async function loader({ context, request }: LoaderFunctionArgs) {
  const { userId } = await requireIoioBorrowerAccess({ context, request });
  return data(payload({ userId }));
}

export async function action({ context, request }: ActionFunctionArgs) {
  const { userId } = context.getSession();
  try {
    const auth = await requireIoioBorrowerAccess({ context, request });
    const parsed = checkoutActionSchema.parse(
      Object.fromEntries(await request.formData())
    );
    if (parsed.intent === "availability") {
      const availability = await getBorrowItemAvailability(
        {
          assetId: parsed.assetId,
          candidateAssetIds: parsed.candidateAssetIds
            ? parsed.candidateAssetIds.split(",").filter(Boolean)
            : undefined,
        },
        { context, request }
      );
      return data({
        ok: true as const,
        intent: "availability" as const,
        availableQuantity: availability.availableWithoutStaffReservations,
        totalQuantity: availability.total,
        staffReservedCount: availability.staffReservedCount,
        availableWithoutStaffReservations:
          availability.availableWithoutStaffReservations,
        staffReservationFrom: availability.staffReservationFrom,
        staffReservationTo: availability.staffReservationTo,
      });
    }
    if (parsed.intent === "refresh-images") {
      const assetIds = [...new Set(parsed.assetIds.split(",").filter(Boolean))];
      const assets = await db.asset.findMany({
        where: {
          organizationId: auth.organizationId,
          id: { in: assetIds },
        },
        select: {
          id: true,
          organizationId: true,
          mainImage: true,
          thumbnailImage: true,
          mainImageStoragePath: true,
          thumbnailImageStoragePath: true,
          assetModel: {
            select: {
              image: true,
              thumbnailImage: true,
              imageStoragePath: true,
              thumbnailImageStoragePath: true,
            },
          },
        },
      });
      const refreshedAssets = await resolveAssetImagesForPresentation(assets);
      return data({
        ok: true as const,
        intent: "images-refreshed" as const,
        assets: refreshedAssets.map(
          ({ id, mainImage, thumbnailImage, assetModel }) => ({
            id,
            mainImage,
            thumbnailImage,
            assetModel,
          })
        ),
      });
    }
    if (parsed.intent === "resolve-qr") {
      const qrId = normalizeQrScanValue(parsed.qrId);
      if (!qrId) throw new Error("Scan a valid physical unit QR code.");
      const requestedAsset = await db.asset.findFirst({
        where: { id: parsed.assetId, organizationId: auth.organizationId },
        select: {
          title: true,
          type: true,
          assetModelId: true,
          assetKits: { select: { kitId: true } },
        },
      });
      const qr = await db.qr.findFirst({
        where: {
          id: qrId,
          organizationId: auth.organizationId,
        },
        select: { assetId: true },
      });
      const scannedAsset = qr?.assetId
        ? await db.asset.findFirst({
            where: {
              id: qr.assetId,
              organizationId: auth.organizationId,
              type: "INDIVIDUAL",
            },
            select: {
              id: true,
              title: true,
              assetModelId: true,
              assetKits: { select: { kitId: true } },
            },
          })
        : null;
      const candidateIds = parsed.candidateAssetIds?.split(",").filter(Boolean);
      const matchesProduct = Boolean(
        requestedAsset &&
          scannedAsset &&
          candidateIds?.includes(scannedAsset.id) &&
          ((requestedAsset.type === "INDIVIDUAL" &&
            requestedAsset.assetModelId &&
            scannedAsset.assetModelId === requestedAsset.assetModelId) ||
            scannedAsset.assetKits.some((candidate) =>
              requestedAsset.assetKits.some(
                (kit) => kit.kitId === candidate.kitId
              )
            ))
      );
      if (!matchesProduct) {
        throw new Error(
          `This QR belongs to ${
            scannedAsset?.title ?? "another item"
          }. Scan a ${requestedAsset?.title ?? "matching Kit"}.`
        );
      }
      if (!scannedAsset) {
        throw new Error(
          "The scanned QR does not resolve to an active Kit unit."
        );
      }
      const unitNumber = getPhysicalUnitLabelFromTitle(scannedAsset.title);
      const resolvedUnit = await resolvePhysicalUnitNumber(
        {
          assetId: parsed.assetId,
          candidateAssetIds: candidateIds,
          unitNumber: unitNumber ?? "",
        },
        { context, request }
      );
      return data({
        ok: true as const,
        intent: "qr-resolved" as const,
        unit: {
          id: resolvedUnit.physicalAssetId,
          title: resolvedUnit.title,
          unitNumber: resolvedUnit.unitNumber,
        },
        qrId,
      });
    }
    if (parsed.intent === "prepare") {
      const parseIdList = (value: string | undefined) =>
        value
          ? z.array(z.string().min(1)).max(100).parse(JSON.parse(value))
          : undefined;
      const proposal = await prepareBorrowItem(
        {
          asset_id: parsed.assetId,
          candidate_asset_ids: parsed.candidateAssetIds
            ? parsed.candidateAssetIds.split(",").filter(Boolean)
            : undefined,
          kit_id: null,
          quantity: parsed.quantity,
          borrow_mode: parsed.borrowMode,
          scanned_asset_id: parsed.scannedAssetId,
          scanned_qr_id: parsed.scannedQrId,
          scanned_asset_ids: parseIdList(parsed.scannedAssetIds),
          scanned_qr_ids: parseIdList(parsed.scannedQrIds),
        },
        { context, request }
      );
      return data({ ok: true as const, intent: "prepared" as const, proposal });
    }
    if (parsed.intent === "request-preparation") {
      const result = await requestPreparationForItem(
        {
          assetId: parsed.assetId,
          candidateAssetIds: parsed.candidateAssetIds
            ? parsed.candidateAssetIds.split(",").filter(Boolean)
            : undefined,
          quantity: parsed.quantity,
          submissionToken: parsed.submissionToken,
          reservationAcknowledgementToken:
            parsed.reservationAcknowledgementToken,
        },
        { context, request }
      );
      return data({
        ok: true as const,
        intent: "preparation-requested" as const,
        result,
      });
    }
    if (parsed.intent === "acknowledge-preparation-reservation") {
      const result = await acknowledgePreparationStaffReservation(
        {
          assetId: parsed.assetId,
          candidateAssetIds: parsed.candidateAssetIds
            ? parsed.candidateAssetIds.split(",").filter(Boolean)
            : undefined,
          quantity: parsed.quantity,
        },
        { context, request }
      );
      return data({
        ok: true as const,
        intent: "preparation-reservation-acknowledged" as const,
        result,
      });
    }

    if (parsed.intent === "confirm") {
      const result = await borrowItem(
        {
          confirmationToken: parsed.confirmationToken,
          quantity: parsed.quantity,
          selectedPhysicalUnitIds: parsed.selectedPhysicalUnitIds
            ? z
                .array(z.string().min(1))
                .max(100)
                .parse(JSON.parse(parsed.selectedPhysicalUnitIds))
            : undefined,
        },
        { context, request }
      );
      return data({ ok: true as const, intent: "confirmed" as const, result });
    }

    if (parsed.intent === "acknowledge-reservation") {
      await acknowledgeBorrowItemStaffReservation(parsed.confirmationToken, {
        context,
        request,
      });
      return data({
        ok: true as const,
        intent: "reservation-acknowledged" as const,
      });
    }

    if (parsed.intent === "confirm-all") {
      const proposals = confirmAllProposalSchema.parse(
        JSON.parse(parsed.proposals) as unknown
      );
      const results: Array<
        | {
            itemId: string;
            kind: "borrow";
            ok: true;
            quantity: number;
            status: string;
            requiresStaffPreparation: boolean;
            dueDate?: string;
          }
        | {
            itemId: string;
            kind: "preparation";
            ok: true;
            quantity: number;
            requestId: string;
          }
        | { itemId: string; ok: false; error: string }
      > = [];
      for (const proposal of proposals) {
        try {
          if (proposal.kind === "preparation") {
            const result = await requestPreparationForItem(
              {
                assetId: proposal.assetId,
                candidateAssetIds: proposal.candidateAssetIds,
                quantity: proposal.quantity,
                submissionToken: proposal.submissionToken,
                reservationAcknowledgementToken:
                  proposal.reservationAcknowledgementToken,
              },
              { context, request }
            );
            results.push({
              itemId: proposal.itemId,
              kind: "preparation",
              ok: true,
              quantity: proposal.quantity,
              requestId: result.requestId,
            });
          } else {
            const result = await borrowItem(
              {
                confirmationToken: proposal.confirmationToken,
                quantity: proposal.quantity,
                selectedPhysicalUnitIds: proposal.selectedPhysicalUnitIds,
              },
              { context, request }
            );
            results.push({
              itemId: proposal.itemId,
              kind: "borrow",
              ok: true,
              quantity: proposal.quantity,
              status: result.status,
              ...("dueDate" in result && result.dueDate
                ? { dueDate: result.dueDate }
                : {}),
              requiresStaffPreparation:
                "requiresStaffPreparation" in result
                  ? result.requiresStaffPreparation === true
                  : false,
            });
          }
        } catch (cause) {
          const reason = makeShelfError(cause, { userId });
          results.push({
            itemId: proposal.itemId,
            ok: false,
            error: reason.message,
          });
        }
      }
      return data({
        ok: true as const,
        intent: "confirmed-all" as const,
        results,
      });
    }

    await cancelBorrowItem(parsed.confirmationToken, { context, request });
    return data({ ok: true as const, intent: "cancelled" as const });
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    return data(
      {
        ok: false as const,
        intent: "error" as const,
        error: reason.message,
      },
      { status: reason.status }
    );
  }
}

type CheckoutActionData =
  | {
      ok: true;
      intent: "qr-resolved";
      unit: { id: string; title: string; unitNumber: string | null };
      qrId: string;
    }
  | {
      ok: true;
      intent: "availability";
      availableQuantity: number;
      totalQuantity: number;
      staffReservedCount: number;
      availableWithoutStaffReservations: number;
      staffReservationFrom: string | null;
      staffReservationTo: string | null;
    }
  | {
      ok: true;
      intent: "prepared";
      proposal: PreparedBorrowProposal;
    }
  | {
      ok: true;
      intent: "preparation-requested";
      result: { ok: true; status: "requested"; requestId: string };
    }
  | {
      ok: true;
      intent: "preparation-reservation-acknowledged";
      result: { confirmationToken: string };
    }
  | { ok: true; intent: "confirmed" | "cancelled"; result?: unknown }
  | { ok: true; intent: "reservation-acknowledged" }
  | {
      ok: true;
      intent: "confirmed-all";
      results: Array<
        | {
            itemId: string;
            kind: "borrow";
            ok: true;
            quantity: number;
            status: string;
            dueDate?: string;
            requiresStaffPreparation?: boolean;
          }
        | {
            itemId: string;
            kind: "preparation";
            ok: true;
            quantity: number;
            requestId: string;
          }
        | { itemId: string; ok: false; error: string }
      >;
    }
  | {
      ok: true;
      intent: "images-refreshed";
      assets: Array<{
        id: string;
        mainImage: string | null;
        thumbnailImage: string | null;
        assetModel: {
          image: string | null;
          thumbnailImage: string | null;
        } | null;
      }>;
    }
  | { ok: false; intent: "error"; error: string };

type ConfirmedBorrowResult = Extract<
  Extract<CheckoutActionData, { intent: "confirmed-all" }>["results"][number],
  { ok: true; kind: "borrow" }
>;

function formatReadableDate(value: string | Date) {
  const date = value instanceof Date ? value : new Date(value);
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function formatLatestReturnDate(maxBorrowDays: number) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + maxBorrowDays);
  return formatReadableDate(date);
}

type ResolvedPhysicalUnit = {
  id: string;
  title: string;
  unitNumber: string;
  qrId: string;
};

type PreparationBasketConfiguration = {
  assetId: string;
  submissionToken: string;
  candidateAssetIds: string[];
  quantity: number;
  requiresStaffReservationAcknowledgement: boolean;
  reservationAcknowledgementToken?: string;
};

function CheckoutLine({
  item,
  onPrepared,
  onPreparationSubmitted,
  onPreparationConfigured,
  pendingApproval,
  accessApprovalRequired,
  onRemove,
}: {
  item: StudentCheckoutItem;
  onPrepared: (
    itemId: string,
    proposal: PreparedBorrowProposal | null,
    displayTitle: string,
    reservationAcknowledged: boolean
  ) => void;
  onPreparationSubmitted: (itemId: string, title: string) => void;
  onPreparationConfigured: (
    itemId: string,
    configuration: PreparationBasketConfiguration | null
  ) => void;
  pendingApproval: boolean;
  accessApprovalRequired: boolean;
  onRemove: () => void;
}) {
  const fetcher = useFetcher<CheckoutActionData>();
  const availabilityFetcher = useFetcher<CheckoutActionData>();
  const qrFetcher = useFetcher<CheckoutActionData>();
  const { setBorrowQuantity } = useStudentCheckout();
  const quantity = item.borrowQuantity;
  const maxBorrowDays = item.maxBorrowDays ?? 45;
  const [proposal, setProposal] = useState<PreparedBorrowProposal | null>(null);
  const offersPreparationChoice = item.requiresStaffPreparation === true;
  const [borrowPath, setBorrowPath] = useState<"have" | "prepare">(
    offersPreparationChoice ? "prepare" : "have"
  );
  const requiresStaffPreparation = Boolean(
    (item.requiresStaffPreparation ?? proposal?.requiresStaffPreparation) &&
      !(offersPreparationChoice && borrowPath === "have")
  );
  const requiresBorrowApproval = Boolean(
    item.requiresBorrowApproval || proposal?.requiresApproval
  );
  const [scanOpen, setScanOpen] = useState(false);
  const [scanPaused, setScanPaused] = useState(false);
  const [selectedUnits, setSelectedUnits] = useState<ResolvedPhysicalUnit[]>(
    []
  );
  const [reservationAcknowledged, setReservationAcknowledged] = useState(false);
  const [preparationAcknowledgement, setPreparationAcknowledgement] = useState<{
    key: string;
    token: string;
  } | null>(null);
  const acknowledgementRequestKeyRef = useRef<string | null>(null);
  const [resolutionError, setResolutionError] = useState<string | null>(null);
  const lastAvailabilityRequestRef = useRef<string | null>(null);
  const lastPrepareRequestRef = useRef<string | null>(null);
  const handledQrResponseRef = useRef<CheckoutActionData | undefined>(
    undefined
  );
  const handledPrepareResponseRef = useRef<CheckoutActionData | undefined>(
    undefined
  );
  const selectedUnitsRef = useRef(selectedUnits);
  selectedUnitsRef.current = selectedUnits;

  const addSelectedUnit = useCallback(
    (
      unit: { id: string; title: string; unitNumber?: string | null },
      qrId: string
    ) => {
      const unitNumber =
        unit.unitNumber ?? getPhysicalUnitLabelFromTitle(unit.title);
      if (!unitNumber) {
        setResolutionError("The physical unit number could not be read.");
        return;
      }
      const currentUnits = selectedUnitsRef.current;
      if (currentUnits.some((selected) => selected.id === unit.id)) {
        setResolutionError(`${unitNumber} has already been added.`);
        return;
      }
      if (currentUnits.length >= quantity) return;
      setSelectedUnits((current) => [
        ...current,
        { ...unit, unitNumber, qrId },
      ]);
      setResolutionError(null);
      setScanOpen(false);
      setScanPaused(true);
      setProposal(null);
      setReservationAcknowledged(false);
      lastPrepareRequestRef.current = null;
    },
    [quantity]
  );

  const removeSelectedUnit = useCallback(
    (unitId: string) => {
      setSelectedUnits((current) =>
        current.filter((unit) => unit.id !== unitId)
      );
      setProposal(null);
      setReservationAcknowledged(false);
      setResolutionError(null);
      setScanOpen(false);
      setScanPaused(false);
      lastPrepareRequestRef.current = null;
      onPrepared(item.id, null, item.title, false);
    },
    [item.id, item.title, onPrepared]
  );

  useEffect(() => {
    const response = fetcher.data;
    if (!response || handledPrepareResponseRef.current === response) return;
    handledPrepareResponseRef.current = response;
    if (response.intent === "prepared") {
      setProposal(response.proposal);
      setReservationAcknowledged(false);
      onPrepared(
        item.id,
        response.proposal,
        selectedUnits[0]?.title ?? item.title,
        false
      );
    }
    if (response.intent === "reservation-acknowledged" && proposal) {
      setReservationAcknowledged(true);
      onPrepared(item.id, proposal, item.title, true);
    }
    if (response.intent === "preparation-reservation-acknowledged") {
      setPreparationAcknowledgement({
        key: acknowledgementRequestKeyRef.current ?? "",
        token: response.result.confirmationToken,
      });
    }
    if (response.intent === "preparation-requested") {
      onPreparationSubmitted(item.id, item.title);
    }
    if (response.intent === "cancelled") {
      setProposal(null);
      setReservationAcknowledged(false);
      onPrepared(item.id, null, item.title, false);
    }
  }, [
    fetcher.data,
    item.id,
    item.title,
    onPreparationSubmitted,
    onPrepared,
    proposal,
    selectedUnits,
  ]);

  useEffect(() => {
    const response = qrFetcher.data;
    if (!response || handledQrResponseRef.current === response) return;
    handledQrResponseRef.current = response;
    if (response.intent === "qr-resolved") {
      addSelectedUnit(response.unit, response.qrId);
    }
    if (!response.ok && response.intent === "error") {
      setResolutionError(response.error);
      setScanPaused(false);
    }
  }, [addSelectedUnit, qrFetcher.data]);

  useEffect(() => {
    const requestKey = `${item.id}:${item.candidateAssetIds.join(",")}`;
    if (lastAvailabilityRequestRef.current === requestKey) return;
    lastAvailabilityRequestRef.current = requestKey;
    void availabilityFetcher.submit(
      {
        intent: "availability",
        assetId: item.id,
        candidateAssetIds: item.candidateAssetIds.join(","),
      },
      { method: "post" }
    );
  }, [availabilityFetcher, item.candidateAssetIds, item.id]);

  const errorMessage =
    fetcher.data?.intent === "error" ? fetcher.data.error : null;
  const dateAvailability =
    availabilityFetcher.data?.intent === "availability"
      ? availabilityFetcher.data.availableWithoutStaffReservations
      : item.availableQuantity;
  const dateMaxQuantity = Math.max(1, dateAvailability);
  const availabilityData =
    availabilityFetcher.data?.intent === "availability"
      ? availabilityFetcher.data
      : null;
  const preparationAcknowledgementKey = `${
    item.id
  }:${quantity}:${item.candidateAssetIds.join(",")}`;
  const preparationAcknowledgementToken =
    preparationAcknowledgement?.key === preparationAcknowledgementKey
      ? preparationAcknowledgement.token
      : undefined;
  const canUseStaffReservationOverlap = Boolean(
    availabilityData &&
      availabilityData.staffReservedCount > 0 &&
      quantity <= availabilityData.availableWithoutStaffReservations
  );
  const requiresPhysicalUnit = item.type === "INDIVIDUAL";
  const requestPreparation =
    offersPreparationChoice && borrowPath === "prepare";
  const needExactUnits = requiresPhysicalUnit && !requestPreparation;
  const canReviewBorrowing =
    !accessApprovalRequired &&
    (quantity <= dateAvailability || canUseStaffReservationOverlap) &&
    (!needExactUnits || selectedUnits.length === quantity);
  const canRequestPreparation = Boolean(
    availabilityData &&
      quantity <= availabilityData.availableWithoutStaffReservations
  );

  useEffect(() => {
    if (!proposal || proposal.quantity === quantity) return;
    // The server proposal is the quantity that will be written to the booking.
    // Invalidate it when the basket quantity changes so the normal prepare path
    // rechecks availability and creates a matching proposal before checkout.
    setProposal(null);
    setReservationAcknowledged(false);
    onPrepared(item.id, null, item.title, false);
    lastPrepareRequestRef.current = null;
  }, [item.id, item.title, onPrepared, proposal, quantity]);

  useEffect(() => {
    onPreparationConfigured(
      item.id,
      requestPreparation && canRequestPreparation && !accessApprovalRequired
        ? {
            assetId: item.id,
            submissionToken: item.preparationSubmissionToken,
            candidateAssetIds: item.candidateAssetIds,
            quantity,
            requiresStaffReservationAcknowledgement:
              (availabilityData?.staffReservedCount ?? 0) > 0,
            reservationAcknowledgementToken: preparationAcknowledgementToken,
          }
        : null
    );
  }, [
    accessApprovalRequired,
    canRequestPreparation,
    item.candidateAssetIds,
    item.id,
    item.preparationSubmissionToken,
    onPreparationConfigured,
    availabilityData?.staffReservedCount,
    preparationAcknowledgementToken,
    quantity,
    requestPreparation,
  ]);
  const preparationKey = `${item.id}:${quantity}:${borrowPath}:${selectedUnits
    .map((unit) => `${unit.id}:${unit.qrId}`)
    .join(",")}`;

  useEffect(() => {
    if (
      proposal ||
      pendingApproval ||
      accessApprovalRequired ||
      fetcher.state !== "idle" ||
      availabilityFetcher.state !== "idle" ||
      !availabilityData ||
      requestPreparation ||
      !canReviewBorrowing ||
      lastPrepareRequestRef.current === preparationKey
    ) {
      return;
    }
    // Keep a failed key claimed. Resetting it on fetcher errors would submit
    // the same preparation again whenever the fetcher returns to idle.
    lastPrepareRequestRef.current = preparationKey;
    void fetcher.submit(
      {
        intent: "prepare",
        assetId: item.id,
        candidateAssetIds: item.candidateAssetIds.join(","),
        quantity: String(quantity),
        borrowMode:
          offersPreparationChoice && borrowPath === "have"
            ? "I_HAVE_ITEM"
            : "STANDARD",
        ...(needExactUnits
          ? {
              scannedAssetId: selectedUnits[0]?.id ?? "",
              scannedQrId: selectedUnits[0]?.qrId ?? "",
              scannedAssetIds: JSON.stringify(
                selectedUnits.map((unit) => unit.id)
              ),
              scannedQrIds: JSON.stringify(
                selectedUnits.map((unit) => unit.qrId)
              ),
            }
          : {}),
      },
      { method: "post" }
    );
  }, [
    availabilityData,
    availabilityFetcher.state,
    accessApprovalRequired,
    canReviewBorrowing,
    fetcher,
    item.candidateAssetIds,
    item.id,
    offersPreparationChoice,
    pendingApproval,
    preparationKey,
    proposal,
    requestPreparation,
    borrowPath,
    quantity,
    needExactUnits,
    selectedUnits,
  ]);

  function resolveQr(qrId: string) {
    const normalized = normalizeQrScanValue(qrId);
    if (!normalized || selectedUnits.length >= quantity) return;
    setResolutionError(null);
    void qrFetcher.submit(
      {
        intent: "resolve-qr",
        assetId: item.id,
        candidateAssetIds: item.candidateAssetIds.join(","),
        qrId: normalized,
      },
      { method: "post" }
    );
  }

  useEffect(() => {
    if (dateAvailability > 0 && quantity > dateMaxQuantity) {
      setBorrowQuantity(item.id, dateMaxQuantity);
    }
  }, [dateAvailability, dateMaxQuantity, item.id, quantity, setBorrowQuantity]);

  useEffect(() => {
    setSelectedUnits((current) => current.slice(0, quantity));
    setProposal(null);
    setReservationAcknowledged(false);
    lastPrepareRequestRef.current = null;
  }, [quantity]);

  const allUnitsSelected = needExactUnits && selectedUnits.length >= quantity;

  return (
    <article className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <Link
            to={`/ioio/browse/${item.id}`}
            aria-label={`View ${item.title}`}
            className="shrink-0 rounded-xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-700"
          >
            <StudentAssetPlaceholder
              asset={item}
              variant="thumbnail"
              className="size-14 rounded-xl"
            />
          </Link>
          <div className="min-w-0">
            <h2 className="font-bold text-gray-950">
              <Link
                to={`/ioio/browse/${item.id}`}
                className="underline-offset-2 hover:text-red-800 hover:underline"
              >
                {item.title}
              </Link>
            </h2>
            <p className="mt-1 text-sm text-gray-600">
              {dateAvailability} available
              {item.location ? ` · ${item.location}` : ""}
            </p>
            {!pendingApproval ? (
              <div className="mt-1">
                <p
                  className={`text-sm font-semibold ${
                    requiresStaffPreparation ||
                    requiresBorrowApproval ||
                    accessApprovalRequired
                      ? "text-amber-900"
                      : "text-green-800"
                  }`}
                >
                  {availabilityData && availabilityData.staffReservedCount > 0
                    ? "Overlaps with selected dates"
                    : dateAvailability <= 0
                    ? "No physical units available"
                    : requiresStaffPreparation
                    ? "Preparation required"
                    : accessApprovalRequired
                    ? "IOIO borrowing approval required"
                    : requiresBorrowApproval
                    ? "TA approval required"
                    : "Available now"}
                </p>
                {dateAvailability > 0 && requiresStaffPreparation ? (
                  <p className="text-xs text-gray-600">
                    A TA will prepare this item for pickup and notify you when
                    it&apos;s ready.
                  </p>
                ) : null}
                {dateAvailability > 0 &&
                !requiresStaffPreparation &&
                !requiresBorrowApproval &&
                !accessApprovalRequired ? (
                  <p className="text-xs text-gray-600">
                    You can take this item immediately after confirming.
                  </p>
                ) : null}
                <p className="text-xs text-gray-600">
                  Maximum {maxBorrowDays} days · Return by{" "}
                  {proposal
                    ? formatReadableDate(proposal.to)
                    : formatLatestReturnDate(maxBorrowDays)}
                </p>
              </div>
            ) : null}
          </div>
        </div>
        <button
          type="button"
          className="text-sm font-semibold text-gray-600 underline hover:text-red-800"
          onClick={onRemove}
        >
          Remove
        </button>
      </div>

      {!pendingApproval && !proposal && offersPreparationChoice ? (
        <fieldset className="mt-3 grid gap-2 sm:grid-cols-2">
          <legend className="mb-1 text-sm font-bold text-gray-900">
            How would you like to borrow it?
          </legend>
          <button
            type="button"
            aria-pressed={borrowPath === "have"}
            onClick={() => {
              setBorrowPath("have");
              setSelectedUnits([]);
              setProposal(null);
              setResolutionError(null);
              lastPrepareRequestRef.current = null;
            }}
            className={`rounded-xl border px-3 py-2.5 text-left text-sm ${
              borrowPath === "have"
                ? "border-red-500 bg-red-50 text-red-950 ring-1 ring-red-200"
                : "border-gray-200 bg-white text-gray-800 hover:border-gray-300"
            }`}
          >
            <span className="block font-bold">I have the kit</span>
            <span className="mt-0.5 block text-xs text-gray-600">
              Scan its QR code
            </span>
          </button>
          <button
            type="button"
            aria-pressed={borrowPath === "prepare"}
            onClick={() => {
              setBorrowPath("prepare");
              setSelectedUnits([]);
              setProposal(null);
              setResolutionError(null);
              lastPrepareRequestRef.current = null;
            }}
            className={`rounded-xl border px-3 py-2.5 text-left text-sm ${
              borrowPath === "prepare"
                ? "border-red-500 bg-red-50 text-red-950 ring-1 ring-red-200"
                : "border-gray-200 bg-white text-gray-800 hover:border-gray-300"
            }`}
          >
            <span className="block font-bold">Prepare for me</span>
            <span className="mt-0.5 block text-xs text-gray-600">
              A TA prepares a unit
            </span>
          </button>
        </fieldset>
      ) : null}

      {!pendingApproval ? (
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm font-semibold text-gray-800">
          <span>Quantity</span>
          <QuantityStepper
            label={`quantity for ${item.title}`}
            value={quantity}
            max={dateMaxQuantity}
            onChange={(nextQuantity) =>
              setBorrowQuantity(item.id, nextQuantity)
            }
            disabled={availabilityFetcher.state !== "idle"}
          />
        </div>
      ) : null}

      {pendingApproval ? (
        <div className="mt-4 rounded-xl bg-blue-50 p-4 text-sm text-blue-950">
          <p className="font-semibold">Request submitted for TA approval.</p>
          <p className="mt-1">
            The item will be assigned after it is approved.
          </p>
        </div>
      ) : proposal ? (
        needExactUnits || proposal.staffReservationWarning ? (
          <div className="mt-3 rounded-xl bg-gray-50 px-3 py-2.5">
            {needExactUnits ? (
              <div className="mb-2 rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-950">
                <p className="font-semibold">
                  {quantity === 1
                    ? "Correct kit"
                    : `${selectedUnits.length} of ${quantity} kits confirmed`}
                </p>
                <ul className="mt-1 space-y-1">
                  {selectedUnits.map((unit) => (
                    <li
                      key={unit.id}
                      className="flex items-center justify-between gap-3"
                    >
                      <span className="min-w-0 truncate">
                        <span aria-hidden="true" className="mr-1 font-bold">
                          ✓
                        </span>
                        <span className="ioio-identifier">
                          {getIoioPhysicalUnitDisplayName({
                            logicalProductName: item.title,
                            unitNumber: unit.unitNumber,
                            missingUnitLabel: "Unit number missing",
                          })}
                        </span>{" "}
                        confirmed
                      </span>
                      <button
                        type="button"
                        className="shrink-0 text-xs font-bold underline"
                        onClick={() => removeSelectedUnit(unit.id)}
                      >
                        Change kit
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {proposal.staffReservationWarning ? (
              <div className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-950">
                <p className="font-bold">Course reservation overlaps</p>
                <p className="mt-1">
                  {proposal.staffReservationWarning.reservedCount} of{" "}
                  {proposal.staffReservationWarning.totalCount} units are
                  reserved from{" "}
                  {formatReadableDate(proposal.staffReservationWarning.from)} to{" "}
                  {formatReadableDate(proposal.staffReservationWarning.to)}.
                </p>
                <p className="mt-1">
                  Only continue if you have permission to borrow them.
                </p>
                {reservationAcknowledged ? (
                  <p className="mt-2 font-semibold">
                    ✓ Course reservation acknowledged
                  </p>
                ) : (
                  <button
                    type="button"
                    className="mt-2 rounded-lg border border-amber-800 px-3 py-2 text-xs font-bold text-amber-950 hover:bg-amber-100"
                    onClick={() => {
                      void fetcher.submit(
                        {
                          intent: "acknowledge-reservation",
                          confirmationToken: proposal.confirmationToken,
                        },
                        { method: "post" }
                      );
                    }}
                    disabled={fetcher.state !== "idle"}
                  >
                    {fetcher.state !== "idle"
                      ? "Saving permission…"
                      : "I have permission — continue"}
                  </button>
                )}
              </div>
            ) : null}
          </div>
        ) : null
      ) : (
        <>
          {needExactUnits ? (
            <div className="mt-4 rounded-xl border border-blue-200 bg-blue-50 p-3">
              <p className="text-sm font-semibold text-blue-950">
                {selectedUnits.length
                  ? `${selectedUnits.length} of ${quantity} ${
                      quantity === 1 ? "kit" : "kits"
                    } confirmed`
                  : "Select each physical unit before borrowing."}
              </p>
              {selectedUnits.length ? (
                <div className="mt-3 space-y-2">
                  {selectedUnits.map((unit) => (
                    <div
                      key={unit.id}
                      className="flex items-center justify-between gap-3 rounded-lg bg-white px-3 py-2 text-sm text-blue-950"
                    >
                      <span className="min-w-0">
                        <span className="mr-2 font-bold text-green-800">✓</span>
                        <strong className="font-semibold">
                          {getIoioPhysicalUnitDisplayName({
                            logicalProductName: item.title,
                            unitNumber: unit.unitNumber,
                            missingUnitLabel: "Unit number missing",
                          })}{" "}
                          confirmed
                        </strong>
                      </span>
                      <button
                        type="button"
                        className="shrink-0 text-xs font-bold underline"
                        onClick={() => removeSelectedUnit(unit.id)}
                      >
                        Change kit
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}
              {!allUnitsSelected ? (
                <>
                  <p className="mt-3 text-xs text-blue-900">
                    {selectedUnits.length
                      ? `${quantity - selectedUnits.length} more ${
                          quantity - selectedUnits.length === 1 ? "kit" : "kits"
                        } needed.`
                      : "Select the required physical units."}
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      setScanOpen(true);
                      setScanPaused(false);
                    }}
                    className="mt-3 rounded-xl bg-red-700 px-4 py-2 text-sm font-bold text-white hover:bg-red-800"
                  >
                    Scan physical unit QR
                  </button>
                  {scanOpen ? (
                    <div className="mx-auto mt-3 aspect-video w-full max-w-2xl overflow-hidden rounded-xl border border-blue-200 bg-slate-900">
                      <CodeScanner
                        className="!h-full !min-h-0 w-full"
                        overlayPosition="centered"
                        onCodeDetectionSuccess={({ value }) => {
                          setScanPaused(true);
                          resolveQr(value);
                        }}
                        allowNonShelfCodes
                        hideBackButtonText
                        forceMode="camera"
                        paused={scanPaused}
                        setPaused={setScanPaused}
                      />
                    </div>
                  ) : null}
                </>
              ) : null}
              {resolutionError ? (
                <p className="mt-2 text-sm font-semibold text-red-700">
                  {resolutionError}
                </p>
              ) : null}
            </div>
          ) : null}
          <div className="mt-3">
            {!requestPreparation ? (
              <p className="mt-2 text-xs font-semibold text-gray-600">
                {availabilityFetcher.state !== "idle"
                  ? "Checking availability..."
                  : accessApprovalRequired
                  ? "Current IOIO access approval is required before borrowing."
                  : fetcher.state !== "idle"
                  ? "Preparing item..."
                  : needExactUnits && !allUnitsSelected
                  ? "Select the required physical units"
                  : errorMessage
                  ? "Unable to prepare this item."
                  : canReviewBorrowing
                  ? "Checking your selection for final confirmation."
                  : "This item is not ready yet."}
              </p>
            ) : null}
            {requestPreparation &&
            availabilityData &&
            canRequestPreparation &&
            availabilityData.staffReservedCount > 0 ? (
              <div className="mt-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-950">
                <p className="font-bold">Course reservation overlaps</p>
                <p className="mt-1">
                  {availabilityData.staffReservedCount} of{" "}
                  {availabilityData.totalQuantity} units are reserved from{" "}
                  {availabilityData.staffReservationFrom
                    ? ` ${formatReadableDate(
                        availabilityData.staffReservationFrom
                      )}`
                    : " course dates"}
                  {availabilityData.staffReservationTo
                    ? ` to ${formatReadableDate(
                        availabilityData.staffReservationTo
                      )}`
                    : ""}
                  . Only continue if you have permission to borrow them.
                </p>
                {preparationAcknowledgementToken ? (
                  <p className="mt-2 font-semibold">
                    ✓ Course reservation acknowledged
                  </p>
                ) : (
                  <button
                    type="button"
                    className="mt-2 rounded-lg border border-amber-800 px-3 py-2 text-xs font-bold text-amber-950 hover:bg-amber-100"
                    onClick={() => {
                      acknowledgementRequestKeyRef.current =
                        preparationAcknowledgementKey;
                      void fetcher.submit(
                        {
                          intent: "acknowledge-preparation-reservation",
                          assetId: item.id,
                          candidateAssetIds: item.candidateAssetIds.join(","),
                          quantity: String(quantity),
                        },
                        { method: "post" }
                      );
                    }}
                    disabled={fetcher.state !== "idle"}
                  >
                    {fetcher.state !== "idle"
                      ? "Saving permission…"
                      : "I have permission — continue"}
                  </button>
                )}
              </div>
            ) : null}
            {requestPreparation &&
            availabilityData &&
            !canRequestPreparation ? (
              <p className="mt-2 text-xs text-amber-900">
                The requested quantity is not available for these dates.
              </p>
            ) : null}
          </div>
        </>
      )}
      {errorMessage ? (
        <p role="alert" className="mt-3 text-sm font-semibold text-red-700">
          {errorMessage}
        </p>
      ) : null}
    </article>
  );
}

export default function IoioCheckout() {
  useLoaderData<typeof loader>();
  const { items, removeItem } = useStudentCheckout();
  const layoutData = useRouteLoaderData<typeof layoutLoader>(
    "routes/_layout+/_layout"
  );
  const annualApprovalRequired =
    !layoutData?.isIoioStaff &&
    !layoutData?.isIoioTA &&
    layoutData?.annualAccessApproval != null &&
    layoutData.annualAccessApproval.required &&
    layoutData.annualAccessApproval.status !== "APPROVED";
  const [preparedLines, setPreparedLines] = useState<
    Record<
      string,
      {
        proposal: PreparedBorrowProposal;
        title: string;
        reservationAcknowledged: boolean;
      }
    >
  >({});
  const [pendingApprovalIds, setPendingApprovalIds] = useState<Set<string>>(
    () => new Set()
  );
  const [preparationConfigurations, setPreparationConfigurations] = useState<
    Record<string, PreparationBasketConfiguration>
  >({});
  const [completedItems, setCompletedItems] = useState<BorrowCompletionItem[]>(
    []
  );
  const [borrowingComplete, setBorrowingComplete] = useState(false);
  const [preparationRequestTitles, setPreparationRequestTitles] = useState<
    string[]
  >([]);
  const confirmFetcher = useFetcher<CheckoutActionData>();
  const imageFetcher = useFetcher<CheckoutActionData>();
  const lastImageRequestKeyRef = useRef<string | null>(null);
  const [currentImages, setCurrentImages] = useState<
    Record<
      string,
      Pick<
        StudentCheckoutItem,
        "mainImage" | "thumbnailImage" | "assetModel" | "kitImage"
      >
    >
  >({});
  const lastHandledBatchResponseRef = useRef<CheckoutActionData | undefined>(
    undefined
  );

  const imageRequestKey = items.map((item) => item.id).join(",");
  useEffect(() => {
    if (!imageRequestKey) {
      lastImageRequestKeyRef.current = null;
      return;
    }
    // useFetcher state changes after submit and may re-run this effect. Only
    // refresh once for each selected-item set, otherwise each response can
    // trigger another action and an unbounded loader revalidation loop.
    if (lastImageRequestKeyRef.current === imageRequestKey) return;
    lastImageRequestKeyRef.current = imageRequestKey;
    void imageFetcher.submit(
      { intent: "refresh-images", assetIds: imageRequestKey },
      { method: "post" }
    );
  }, [imageFetcher, imageRequestKey]);

  useEffect(() => {
    const response = imageFetcher.data;
    if (!response || response.intent !== "images-refreshed" || !response.ok) {
      return;
    }
    setCurrentImages(
      Object.fromEntries(
        response.assets.map((asset) => [
          asset.id,
          {
            mainImage: asset.mainImage,
            thumbnailImage: asset.thumbnailImage,
            assetModel:
              items.find((item) => item.id === asset.id)?.assetModel ?? null,
            kitImage:
              items.find((item) => item.id === asset.id)?.kitImage ?? null,
          },
        ])
      )
    );
  }, [imageFetcher.data, items]);

  const handlePrepared = useCallback(
    (
      itemId: string,
      proposal: PreparedBorrowProposal | null,
      title: string,
      reservationAcknowledged: boolean
    ) => {
      setPreparedLines((current) => {
        const next = { ...current };
        if (proposal) {
          next[itemId] = { proposal, title, reservationAcknowledged };
        } else delete next[itemId];
        return next;
      });
      setPreparationConfigurations((current) => {
        if (!current[itemId]) return current;
        const next = { ...current };
        delete next[itemId];
        return next;
      });
      if (!proposal) {
        setPendingApprovalIds((current) => {
          const next = new Set(current);
          next.delete(itemId);
          return next;
        });
      }
    },
    []
  );

  const handlePreparationConfigured = useCallback(
    (itemId: string, configuration: PreparationBasketConfiguration | null) => {
      setPreparationConfigurations((current) => {
        if (!configuration) {
          if (!current[itemId]) return current;
          const next = { ...current };
          delete next[itemId];
          return next;
        }
        const previous = current[itemId];
        if (
          previous?.assetId === configuration.assetId &&
          previous.submissionToken === configuration.submissionToken &&
          previous.quantity === configuration.quantity &&
          previous.reservationAcknowledgementToken ===
            configuration.reservationAcknowledgementToken &&
          previous.requiresStaffReservationAcknowledgement ===
            configuration.requiresStaffReservationAcknowledgement &&
          previous.candidateAssetIds.join(",") ===
            configuration.candidateAssetIds.join(",")
        ) {
          return current;
        }
        return { ...current, [itemId]: configuration };
      });
    },
    []
  );

  const handlePreparationSubmitted = useCallback(
    (itemId: string, title: string) => {
      setPreparationRequestTitles((current) => [...current, title]);
      setPreparationConfigurations((current) => {
        if (!current[itemId]) return current;
        const next = { ...current };
        delete next[itemId];
        return next;
      });
      removeItem(itemId);
    },
    [removeItem]
  );

  useEffect(() => {
    const response = confirmFetcher.data;
    if (
      !response ||
      response.intent !== "confirmed-all" ||
      !response.ok ||
      lastHandledBatchResponseRef.current === response
    ) {
      return;
    }
    lastHandledBatchResponseRef.current = response;
    const successful = response.results.filter((result) => result.ok);
    const pending = new Set(
      successful
        .filter(
          (result) =>
            result.kind === "borrow" && result.status === "pending_approval"
        )
        .map((result) => result.itemId)
    );
    setPendingApprovalIds(pending);
    const completed = successful.filter(
      (result): result is ConfirmedBorrowResult =>
        result.kind === "borrow" && result.status !== "pending_approval"
    );
    const completions = completed.flatMap((result) => {
      const line = preparedLines[result.itemId];
      if (!line) return [];
      return [
        {
          itemId: result.itemId,
          title: line.title,
          quantity: result.quantity,
          dueDate: result.requiresStaffPreparation
            ? undefined
            : result.dueDate ?? line.proposal.to.slice(0, 10),
          requiresStaffPreparation: result.requiresStaffPreparation,
        },
      ];
    });
    setCompletedItems(completions);
    completed.forEach((result) => removeItem(result.itemId));
    const preparationRequests = successful.filter(
      (result) => result.kind === "preparation"
    );
    if (preparationRequests.length) {
      const titles = preparationRequests.flatMap(({ itemId }) => {
        const title = items.find((item) => item.id === itemId)?.title;
        return title ? [title] : [];
      });
      setPreparationRequestTitles((current) => [...current, ...titles]);
      setPreparationConfigurations((current) => {
        const next = { ...current };
        preparationRequests.forEach(({ itemId }) => delete next[itemId]);
        return next;
      });
      preparationRequests.forEach(({ itemId }) => removeItem(itemId));
    }
    if (
      pending.size === 0 &&
      completions.length > 0 &&
      preparationRequests.length === 0 &&
      response.results.every((result) => result.ok)
    ) {
      setBorrowingComplete(true);
    }
  }, [confirmFetcher.data, items, preparedLines, removeItem]);

  const allItemsReady =
    items.length > 0 &&
    items.every((item) => {
      const line = preparedLines[item.id];
      const preparation = preparationConfigurations[item.id];
      return Boolean(
        (preparation &&
          (!preparation.requiresStaffReservationAcknowledgement ||
            Boolean(preparation.reservationAcknowledgementToken))) ||
          (line &&
            !pendingApprovalIds.has(item.id) &&
            (line.proposal.staffReservationWarning === null ||
              line.reservationAcknowledged))
      );
    });
  const batchProposals: z.infer<typeof confirmAllProposalSchema> = [];
  items.forEach((item) => {
    const line = preparedLines[item.id];
    if (line) {
      batchProposals.push({
        kind: "borrow" as const,
        itemId: item.id,
        confirmationToken: line.proposal.confirmationToken,
        quantity: line.proposal.quantity,
        selectedPhysicalUnitIds: line.proposal.selectedPhysicalUnitIds,
      });
      return;
    }
    const preparation = preparationConfigurations[item.id];
    if (preparation) {
      batchProposals.push({
        kind: "preparation",
        itemId: item.id,
        assetId: preparation.assetId,
        submissionToken: preparation.submissionToken,
        candidateAssetIds: preparation.candidateAssetIds,
        quantity: preparation.quantity,
        reservationAcknowledgementToken:
          preparation.reservationAcknowledgementToken,
      });
    }
  });

  if (borrowingComplete) {
    return (
      <BorrowSuccess
        items={completedItems}
        dashboardPath={layoutData?.isIoioStaff ? "/home" : "/ioio"}
        completionPath={
          completedItems.some((item) => item.requiresStaffPreparation) &&
          !layoutData?.isIoioStaff
            ? "/ioio/loans"
            : layoutData?.isIoioStaff
            ? "/home"
            : "/ioio"
        }
        completionLabel={
          completedItems.some((item) => item.requiresStaffPreparation) &&
          !layoutData?.isIoioStaff
            ? "Go to My Loans"
            : "Go to Dashboard"
        }
      />
    );
  }

  return (
    <div>
      <SectionHeading
        title="Borrowing list"
        text="Choose a borrowing option for each item, then confirm."
      />
      {preparationRequestTitles.length ? (
        <div
          className="mb-4 rounded-xl border border-green-200 bg-green-50 p-4 text-sm text-green-950"
          role="status"
        >
          <p className="font-bold">Preparation requested</p>
          <p className="mt-1">
            {preparationRequestTitles.join(", ")} — a TA will prepare the
            equipment and let you know when it is ready.
          </p>
          <Link
            to="/ioio/loans"
            className="mt-2 inline-flex font-bold text-red-800 underline"
          >
            View My Loans
          </Link>
        </div>
      ) : null}
      {!borrowingComplete && completedItems.length ? (
        <div
          className="mb-4 rounded-xl border border-green-200 bg-green-50 p-4 text-sm text-green-950"
          role="status"
        >
          <p className="font-bold">Borrowing confirmed</p>
          <ul className="mt-1 list-inside list-disc">
            {completedItems.map((item) => (
              <li key={item.itemId}>
                {item.quantity}x {item.title}
                {item.dueDate
                  ? ` · Return by ${formatReadableDate(item.dueDate)}`
                  : ""}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {items.length ? (
        <div className="space-y-3">
          {items.map((item) => (
            <CheckoutLine
              key={item.id}
              item={{ ...item, ...(currentImages[item.id] ?? {}) }}
              onPrepared={handlePrepared}
              onPreparationSubmitted={handlePreparationSubmitted}
              onPreparationConfigured={handlePreparationConfigured}
              pendingApproval={pendingApprovalIds.has(item.id)}
              accessApprovalRequired={annualApprovalRequired}
              onRemove={() => removeItem(item.id)}
            />
          ))}
          <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
            {annualApprovalRequired ? (
              <p className="text-sm text-gray-600">
                Current IOIO borrowing approval is required.
              </p>
            ) : !allItemsReady ? (
              <p className="text-sm text-gray-600">
                Complete the setup for each item first.
              </p>
            ) : null}
            {annualApprovalRequired ? (
              <Link
                to="/ioio/settings/access-approval"
                className="mt-3 inline-flex rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm font-bold text-red-800 hover:bg-red-100"
              >
                Request approval
              </Link>
            ) : null}
            <confirmFetcher.Form method="post" className="mt-3">
              <input type="hidden" name="intent" value="confirm-all" />
              <input
                type="hidden"
                name="proposals"
                value={JSON.stringify(batchProposals)}
              />
              <div className="flex flex-wrap items-center justify-end gap-2">
                <Link
                  to="/ioio"
                  className="inline-flex min-h-10 items-center justify-center rounded-xl border border-gray-300 px-4 text-sm font-semibold text-gray-700 hover:border-gray-400"
                >
                  Cancel
                </Link>
                <button
                  type="submit"
                  disabled={
                    annualApprovalRequired ||
                    !allItemsReady ||
                    confirmFetcher.state !== "idle"
                  }
                  className="inline-flex min-h-10 items-center justify-center rounded-xl bg-red-700 px-4 text-sm font-bold text-white hover:bg-red-800 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {confirmFetcher.state !== "idle"
                    ? "Confirming borrowing..."
                    : "Confirm borrowing"}
                </button>
              </div>
            </confirmFetcher.Form>
            {confirmFetcher.data?.intent === "error" ? (
              <p
                role="alert"
                className="mt-3 text-sm font-semibold text-red-700"
              >
                {confirmFetcher.data.error}
              </p>
            ) : null}
            {confirmFetcher.data?.intent === "confirmed-all" &&
            confirmFetcher.data.results.some((result) => !result.ok) ? (
              <div
                role="alert"
                className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900"
              >
                <p className="font-bold">
                  Some items could not be submitted. They remain in your list.
                </p>
                <ul className="mt-1 list-disc pl-5">
                  {confirmFetcher.data.results.flatMap((result) => {
                    if (result.ok) return [];
                    const title = items.find(
                      (item) => item.id === result.itemId
                    )?.title;
                    return [
                      <li key={result.itemId}>
                        {title ?? "Item"}: {result.error}
                      </li>,
                    ];
                  })}
                </ul>
              </div>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="rounded-2xl border border-dashed border-gray-300 bg-white p-8 text-center text-sm text-gray-600">
          Your borrowing list is empty. Add equipment from Inventory to begin.
        </div>
      )}
    </div>
  );
}
