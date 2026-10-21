import {
  IOIO_A4,
  IOIO_A4_PRINTABLE_AREA,
  type IoioPrintDimensions,
} from "./ioio-label-sizing";

export type IoioQueuedLabelType =
  | "room"
  | "section"
  | "shelf"
  | "container"
  | "item"
  | "kit";

export type IoioLabelQueueEntry = {
  type: IoioQueuedLabelType;
  id: string;
};

export type IoioLocationLabelType = Extract<
  IoioQueuedLabelType,
  "room" | "section" | "shelf" | "container"
>;

type IoioLabelQueueStorage = Pick<Storage, "getItem" | "setItem">;

const LOCATION_LABEL_TYPES = new Set<IoioQueuedLabelType>([
  "room",
  "section",
  "shelf",
  "container",
]);
const QUEUED_LABEL_TYPES = new Set<IoioQueuedLabelType>([
  ...LOCATION_LABEL_TYPES,
  "item",
  "kit",
]);

export function getIoioLabelQueueStorageKey(organizationId: string) {
  return `ioio-label-queue:v1:${organizationId}`;
}

/** Read only canonical IDs and label types; names and other label data stay live. */
export function readIoioLabelQueue(
  storage: IoioLabelQueueStorage,
  organizationId: string
) {
  try {
    const value = storage.getItem(getIoioLabelQueueStorageKey(organizationId));
    if (!value) return [];

    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];

    return parsed.reduce<IoioLabelQueueEntry[]>((queue, candidate) => {
      if (
        candidate &&
        typeof candidate === "object" &&
        "type" in candidate &&
        typeof candidate.type === "string" &&
        QUEUED_LABEL_TYPES.has(candidate.type as IoioQueuedLabelType) &&
        "id" in candidate &&
        typeof candidate.id === "string" &&
        candidate.id.length > 0
      ) {
        return addIoioLabelToQueue(queue, {
          type: candidate.type as IoioQueuedLabelType,
          id: candidate.id,
        });
      }
      return queue;
    }, []);
  } catch {
    return [];
  }
}

export function writeIoioLabelQueue(
  storage: IoioLabelQueueStorage,
  organizationId: string,
  queue: IoioLabelQueueEntry[]
) {
  try {
    storage.setItem(
      getIoioLabelQueueStorageKey(organizationId),
      JSON.stringify(queue)
    );
  } catch {
    // Storage can be unavailable in restricted browser contexts. The in-page
    // queue remains usable even when persistence cannot be written.
  }
}

export type IoioSizedLabel<T> = {
  value: T;
  dimensions: IoioPrintDimensions;
};

export type IoioLabelPageRow<T> = {
  heightMm: number;
  labels: IoioSizedLabel<T>[];
};

export type IoioLabelPage<T> = {
  rows: IoioLabelPageRow<T>[];
};

function queueKey(entry: IoioLabelQueueEntry) {
  return entry.id;
}

export function addIoioLabelToQueue(
  queue: IoioLabelQueueEntry[],
  entry: IoioLabelQueueEntry
) {
  return queue.some((queued) => queueKey(queued) === queueKey(entry))
    ? queue
    : [...queue, entry];
}

export function removeIoioLabelFromQueue(
  queue: IoioLabelQueueEntry[],
  entry: IoioLabelQueueEntry
) {
  return queue.filter((queued) => queueKey(queued) !== queueKey(entry));
}

export function clearIoioLabelQueue(queue: IoioLabelQueueEntry[]) {
  return queue.length === 0 ? queue : [];
}

/** Drop missing/broken location paths and update queued level after reparenting. */
export function reconcileIoioLabelQueue(
  queue: IoioLabelQueueEntry[],
  currentLocationTypes: ReadonlyMap<string, IoioLocationLabelType | null>
) {
  return queue.reduce<IoioLabelQueueEntry[]>((reconciled, entry) => {
    if (!LOCATION_LABEL_TYPES.has(entry.type)) {
      return addIoioLabelToQueue(reconciled, entry);
    }

    const currentType = currentLocationTypes.get(entry.id);
    if (!currentType) return reconciled;
    return addIoioLabelToQueue(reconciled, { type: currentType, id: entry.id });
  }, []);
}

/** Returns the current Shelf row, never a label snapshot from queue storage. */
export function resolveIoioQueuedLocation<T extends { id: string }>(
  entry: IoioLabelQueueEntry,
  locationsById: ReadonlyMap<string, T>,
  currentLocationTypes: ReadonlyMap<string, IoioLocationLabelType | null>
) {
  if (!LOCATION_LABEL_TYPES.has(entry.type)) return undefined;

  const type = currentLocationTypes.get(entry.id);
  const location = locationsById.get(entry.id);
  return type && location ? { location, type } : undefined;
}

export function toggleIoioLabelInQueue(
  queue: IoioLabelQueueEntry[],
  entry: IoioLabelQueueEntry
) {
  return queue.some((queued) => queueKey(queued) === queueKey(entry))
    ? removeIoioLabelFromQueue(queue, entry)
    : addIoioLabelToQueue(queue, entry);
}

export function packIoioLabelsForA4<T>(labels: IoioSizedLabel<T>[]) {
  if (labels.length === 0) return [] as IoioLabelPage<T>[];

  const printableWidthMm = IOIO_A4_PRINTABLE_AREA.widthMm;
  const printableHeightMm = IOIO_A4_PRINTABLE_AREA.heightMm;
  const pages: IoioLabelPage<T>[] = [];
  let page: IoioLabelPage<T> = { rows: [] };
  let pageHeightMm = 0;
  let row: IoioSizedLabel<T>[] = [];
  let rowWidthMm = 0;
  let rowHeightMm = 0;

  const startPage = () => {
    if (page.rows.length > 0) pages.push(page);
    page = { rows: [] };
    pageHeightMm = 0;
  };

  const flushRow = () => {
    if (row.length === 0) return;

    const verticalGap = page.rows.length > 0 ? IOIO_A4.gapMm : 0;
    if (pageHeightMm + verticalGap + rowHeightMm > printableHeightMm) {
      startPage();
    }

    const nextVerticalGap = page.rows.length > 0 ? IOIO_A4.gapMm : 0;
    page.rows.push({ heightMm: rowHeightMm, labels: row });
    pageHeightMm += nextVerticalGap + rowHeightMm;
    row = [];
    rowWidthMm = 0;
    rowHeightMm = 0;
  };

  for (const label of labels) {
    const { widthMm, heightMm } = label.dimensions;
    if (
      widthMm > printableWidthMm ||
      heightMm > printableHeightMm ||
      !Number.isFinite(widthMm) ||
      !Number.isFinite(heightMm) ||
      widthMm <= 0 ||
      heightMm <= 0
    ) {
      continue;
    }

    const nextWidth =
      rowWidthMm + (row.length > 0 ? IOIO_A4.gapMm : 0) + widthMm;
    if (row.length > 0 && nextWidth > printableWidthMm) flushRow();

    rowWidthMm += (row.length > 0 ? IOIO_A4.gapMm : 0) + widthMm;
    rowHeightMm = Math.max(rowHeightMm, heightMm);
    row.push(label);
  }

  flushRow();
  if (page.rows.length > 0) pages.push(page);
  return pages;
}
