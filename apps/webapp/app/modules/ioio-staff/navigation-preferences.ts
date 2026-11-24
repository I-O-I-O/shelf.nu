/**
 * Helpers for the IOIO Staff sidebar's browser-only ordering preference.
 * The key is scoped to both the signed-in user and selected organization.
 */
export function getStaffNavigationStorageKey(
  userId: string,
  organizationId: string
) {
  return `ioio-staff-navigation-order:${encodeURIComponent(
    organizationId
  )}:${encodeURIComponent(userId)}`;
}

/**
 * Preserve the saved order of current items, discard stale/duplicate IDs, and
 * insert newly-added items near their canonical position. Invalid preferences
 * fall back to the canonical order.
 */
export function normalizeStaffNavigationOrder(
  value: unknown,
  defaultOrder: readonly string[]
) {
  if (!Array.isArray(value)) return [...defaultOrder];

  const known = new Set(defaultOrder);
  const savedOrder = [...new Set(value)].filter(
    (item): item is string => typeof item === "string" && known.has(item)
  );
  if (savedOrder.length === 0) return [...defaultOrder];

  const order = [...savedOrder];
  for (let index = 0; index < defaultOrder.length; index += 1) {
    const item = defaultOrder[index];
    if (order.includes(item)) continue;

    const nextCanonicalItem = defaultOrder
      .slice(index + 1)
      .find((candidate) => order.includes(candidate));
    if (nextCanonicalItem) {
      order.splice(order.indexOf(nextCanonicalItem), 0, item);
    } else {
      order.push(item);
    }
  }

  return order;
}

export function readStaffNavigationOrder(
  storageKey: string,
  defaultOrder: readonly string[]
) {
  if (typeof window === "undefined") return [...defaultOrder];

  try {
    const saved = JSON.parse(window.localStorage.getItem(storageKey) ?? "null");
    return normalizeStaffNavigationOrder(saved, defaultOrder);
  } catch {
    return [...defaultOrder];
  }
}

export function saveStaffNavigationOrder(
  storageKey: string,
  order: readonly string[]
) {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(storageKey, JSON.stringify(order));
  } catch {
    // Storage can be unavailable or full; the in-memory sidebar still works.
  }
}
