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
