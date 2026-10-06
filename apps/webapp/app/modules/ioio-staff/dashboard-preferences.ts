export const STAFF_DASHBOARD_WIDGETS = [
  { id: "operations", label: "Operations" },
  { id: "purchasing", label: "Purchasing" },
  { id: "lab_tasks", label: "Lab tasks" },
  { id: "ta_hours", label: "TA hours" },
  { id: "inventory_import", label: "Inventory import" },
] as const;

export type StaffDashboardWidgetId =
  (typeof STAFF_DASHBOARD_WIDGETS)[number]["id"];

export type StaffDashboardPreferences = {
  order: StaffDashboardWidgetId[];
  hidden: StaffDashboardWidgetId[];
};

export const DEFAULT_STAFF_DASHBOARD_PREFERENCES: StaffDashboardPreferences = {
  // Preserve the current dashboard order for users without saved preferences.
  order: [
    "operations",
    "purchasing",
    "lab_tasks",
    "ta_hours",
    "inventory_import",
  ],
  hidden: [],
};

const widgetIds = new Set<string>(STAFF_DASHBOARD_WIDGETS.map(({ id }) => id));

/**
 * Tolerate old, partial, or future preference records. Known widgets retain
 * their saved order; unknown IDs are ignored; newly-added widgets are appended.
 */
export function normalizeStaffDashboardPreferences(
  value: unknown
): StaffDashboardPreferences {
  if (!value || typeof value !== "object") {
    return { ...DEFAULT_STAFF_DASHBOARD_PREFERENCES };
  }

  const candidate = value as { order?: unknown; hidden?: unknown };
  const savedOrder = Array.isArray(candidate.order)
    ? candidate.order.filter(
        (id): id is StaffDashboardWidgetId =>
          typeof id === "string" && widgetIds.has(id)
      )
    : [];
  const uniqueOrder = [...new Set(savedOrder)];
  const order = [
    ...uniqueOrder,
    ...DEFAULT_STAFF_DASHBOARD_PREFERENCES.order.filter(
      (id) => !uniqueOrder.includes(id)
    ),
  ];
  const hidden = Array.isArray(candidate.hidden)
    ? [...new Set(candidate.hidden)].filter(
        (id): id is StaffDashboardWidgetId =>
          typeof id === "string" && widgetIds.has(id)
      )
    : [];

  return { order, hidden };
}
