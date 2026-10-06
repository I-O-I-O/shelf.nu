import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { StudentAsset } from "~/modules/ioio-student/service.server";
import type { StudentInventoryItem } from "./inventory-presentation";

export type StudentCheckoutItem = {
  id: string;
  title: string;
  type: StudentAsset["type"];
  isKit: boolean;
  mainImage: string | null;
  thumbnailImage: string | null;
  kitImage?: string | null;
  quantity: number;
  borrowQuantity: number;
  assetModel: StudentAsset["assetModel"];
  availableQuantity: number;
  maxBorrowDays: number | null;
  requiresBorrowApproval?: boolean;
  requiresStaffPreparation?: boolean;
  location: string | null;
  candidateAssetIds: string[];
};

type StudentCheckoutContextValue = {
  items: StudentCheckoutItem[];
  recentlyAdded: { id: string; title: string; addedAt: number } | null;
  addItem: (
    asset: StudentAsset | StudentInventoryItem | StudentCheckoutItem
  ) => void;
  removeItem: (assetId: string) => void;
  setBorrowQuantity: (assetId: string, quantity: number) => void;
  hasItem: (assetId: string) => boolean;
};

const STORAGE_KEY = "ioio-student-checkout";
const StudentCheckoutContext = createContext<
  StudentCheckoutContextValue | undefined
>(undefined);

function isAssetType(value: unknown): value is StudentAsset["type"] {
  return value === "INDIVIDUAL" || value === "QUANTITY_TRACKED";
}

function normalizeAssetModel(value: unknown): StudentAsset["assetModel"] {
  if (typeof value !== "object" || value === null) return null;
  const model = value as Record<string, unknown>;
  if (typeof model.id !== "string" || typeof model.name !== "string") {
    return null;
  }
  return {
    id: model.id,
    name: model.name,
    image: typeof model.image === "string" ? model.image : null,
    thumbnailImage:
      typeof model.thumbnailImage === "string" ? model.thumbnailImage : null,
  };
}

function normalizeSavedItem(value: unknown): StudentCheckoutItem | null {
  if (typeof value !== "object" || value === null) return null;
  const item = value as Record<string, unknown>;
  if (
    typeof item.id !== "string" ||
    typeof item.title !== "string" ||
    typeof item.availableQuantity !== "number"
  ) {
    return null;
  }

  const candidateAssetIds = Array.isArray(item.candidateAssetIds)
    ? item.candidateAssetIds.filter(
        (candidateId): candidateId is string => typeof candidateId === "string"
      )
    : [item.id];

  return {
    id: item.id,
    title: item.title,
    type: isAssetType(item.type) ? item.type : "QUANTITY_TRACKED",
    isKit: item.isKit === true,
    mainImage: typeof item.mainImage === "string" ? item.mainImage : null,
    thumbnailImage:
      typeof item.thumbnailImage === "string" ? item.thumbnailImage : null,
    kitImage: typeof item.kitImage === "string" ? item.kitImage : null,
    quantity:
      typeof item.quantity === "number"
        ? Math.max(0, item.quantity)
        : Math.max(0, item.availableQuantity),
    borrowQuantity:
      typeof item.borrowQuantity === "number" &&
      Number.isInteger(item.borrowQuantity) &&
      item.borrowQuantity > 0
        ? item.borrowQuantity
        : 1,
    assetModel: normalizeAssetModel(item.assetModel),
    availableQuantity: Math.max(0, item.availableQuantity),
    maxBorrowDays:
      typeof item.maxBorrowDays === "number" ? item.maxBorrowDays : null,
    requiresBorrowApproval: item.requiresBorrowApproval === true,
    requiresStaffPreparation: item.requiresStaffPreparation === true,
    location: typeof item.location === "string" ? item.location : null,
    candidateAssetIds: candidateAssetIds.length ? candidateAssetIds : [item.id],
  };
}

function checkoutItemFromAsset(
  asset: StudentAsset | StudentInventoryItem
): StudentCheckoutItem {
  return {
    id: asset.id,
    title: asset.title,
    type: asset.type,
    isKit: asset.kits.length > 0,
    mainImage: asset.mainImage,
    thumbnailImage: asset.thumbnailImage,
    kitImage: asset.kitImage ?? null,
    quantity: Math.max(0, asset.quantity ?? 0),
    borrowQuantity: 1,
    assetModel: asset.assetModel,
    availableQuantity: Math.max(0, asset.availableQuantity ?? 0),
    maxBorrowDays: asset.maxBorrowDays ?? 45,
    requiresBorrowApproval:
      "requiresBorrowApproval" in asset &&
      asset.requiresBorrowApproval === true,
    requiresStaffPreparation: asset.requiresStaffPreparation,
    location: asset.locations[0]?.name ?? null,
    candidateAssetIds:
      "sourceAssetIds" in asset && Array.isArray(asset.sourceAssetIds)
        ? asset.sourceAssetIds
        : [asset.id],
  };
}

export function StudentCheckoutProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<StudentCheckoutItem[]>([]);
  const [recentlyAdded, setRecentlyAdded] = useState<{
    id: string;
    title: string;
    addedAt: number;
  } | null>(null);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    try {
      const saved = JSON.parse(
        window.sessionStorage.getItem(STORAGE_KEY) ?? "null"
      ) as unknown;
      if (!Array.isArray(saved)) return;
      setItems(
        saved.flatMap((item) => {
          const normalized = normalizeSavedItem(item);
          return normalized ? [normalized] : [];
        })
      );
    } catch {
      setItems([]);
    } finally {
      setHydrated(true);
    }
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  }, [hydrated, items]);

  useEffect(() => {
    if (!recentlyAdded) return;
    const timeout = window.setTimeout(() => setRecentlyAdded(null), 2100);
    return () => window.clearTimeout(timeout);
  }, [recentlyAdded]);

  const value = useMemo<StudentCheckoutContextValue>(
    () => ({
      items,
      recentlyAdded,
      addItem: (asset) => {
        const item =
          "candidateAssetIds" in asset ? asset : checkoutItemFromAsset(asset);
        if (items.some((existing) => existing.id === item.id)) return;
        setItems((current) =>
          current.some((existing) => existing.id === item.id)
            ? current
            : [...current, item]
        );
        setRecentlyAdded({
          id: item.id,
          title: item.title,
          addedAt: Date.now(),
        });
      },
      removeItem: (assetId) => {
        setItems((current) => current.filter((item) => item.id !== assetId));
        setRecentlyAdded((current) =>
          current?.id === assetId ? null : current
        );
      },
      setBorrowQuantity: (assetId, quantity) => {
        if (!Number.isInteger(quantity) || quantity < 1) return;
        setItems((current) =>
          current.map((item) =>
            item.id === assetId ? { ...item, borrowQuantity: quantity } : item
          )
        );
      },
      hasItem: (assetId) => items.some((item) => item.id === assetId),
    }),
    [items, recentlyAdded]
  );

  return (
    <StudentCheckoutContext.Provider value={value}>
      {children}
    </StudentCheckoutContext.Provider>
  );
}

export function useStudentCheckout() {
  const value = useContext(StudentCheckoutContext);
  if (!value) {
    throw new Error(
      "useStudentCheckout must be used inside StudentCheckoutProvider"
    );
  }
  return value;
}
