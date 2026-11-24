export type EmailTemplateCategory =
  | "Borrowing"
  | "Returns"
  | "Extensions"
  | "Account"
  | "Operational";

export const EMAIL_TEMPLATE_CATEGORY_ORDER: EmailTemplateCategory[] = [
  "Borrowing",
  "Returns",
  "Extensions",
  "Account",
  "Operational",
];

export type EmailTemplateDefinition = {
  key: string;
  name: string;
  description: string;
  category: EmailTemplateCategory;
  subject: string;
  body: string;
  variables: string[];
  editable: boolean;
  canDisable: boolean;
};

export const EMAIL_TEMPLATE_DEFINITIONS = [
  {
    key: "booking_reservation",
    name: "Course reservation created",
    description:
      "Sent when a planned course or workshop reservation is created.",
    category: "Borrowing",
    subject: "Course reservation created: {{bookingName}}",
    body: "Hi {{displayName}},\n\nYour course reservation {{bookingName}} has been created.\n\nDates: {{startDate}} to {{endDate}}\nItems: {{assetCount}}\n\nIOIO Lab",
    variables: [
      "displayName",
      "bookingName",
      "assetCount",
      "startDate",
      "endDate",
    ],
    editable: true,
    canDisable: true,
  },
  {
    key: "booking_completed",
    name: "Return confirmation",
    description: "Sent after equipment is checked back in successfully.",
    category: "Returns",
    subject: "Return confirmed: {{bookingName}}",
    body: "Hi {{displayName}},\n\nYour return of {{bookingName}} has been recorded.\n\nThank you.\n\nIOIO Lab",
    variables: ["displayName", "bookingName"],
    editable: true,
    canDisable: true,
  },
  {
    key: "booking_overdue",
    name: "Overdue return",
    description: "Sent when equipment passes its expected return date.",
    category: "Returns",
    subject: "Return overdue: {{bookingName}}",
    body: "Hi {{displayName}},\n\nYour borrowing period for {{bookingName}} has passed its return date.\n\nReturn by: {{endDate}}\n\nPlease return the equipment or request an extension from My Loans.\n\nIOIO Lab",
    variables: ["displayName", "bookingName", "endDate"],
    editable: true,
    canDisable: true,
  },
  {
    key: "booking_cancelled",
    name: "Course reservation cancelled",
    description:
      "Sent when a planned course or workshop reservation is cancelled.",
    category: "Borrowing",
    subject: "Course reservation cancelled: {{bookingName}}",
    body: "Hi {{displayName}},\n\nYour course reservation {{bookingName}} was cancelled.\n\nIOIO Lab",
    variables: ["displayName", "bookingName"],
    editable: true,
    canDisable: true,
  },
  {
    key: "booking_extended",
    name: "Extension approved",
    description: "Sent when a requested return-date extension is approved.",
    category: "Extensions",
    subject: "Extension approved: {{bookingName}}",
    body: "Hi {{displayName}},\n\nYour extension for {{bookingName}} has been approved.\n\nNew return date: {{endDate}}\n\nIOIO Lab",
    variables: ["displayName", "bookingName", "endDate"],
    editable: true,
    canDisable: true,
  },
  {
    key: "booking_deleted",
    name: "Reservation removed",
    description:
      "Sent when a reservation is removed from the planning calendar.",
    category: "Operational",
    subject: "Reservation removed: {{bookingName}}",
    body: "Hi {{displayName}},\n\nYour course reservation {{bookingName}} was removed from the planning calendar.\n\nIOIO Lab",
    variables: ["displayName", "bookingName"],
    editable: true,
    canDisable: true,
  },
  {
    key: "booking_updated",
    name: "Course reservation updated",
    description:
      "Sent when dates, equipment, or details change on a reservation.",
    category: "Borrowing",
    subject: "Course reservation updated: {{bookingName}}",
    body: "Hi {{displayName}},\n\nYour course reservation {{bookingName}} has been updated.\n\nPlease review the new details in IOIO Lab.\n\nIOIO Lab",
    variables: ["displayName", "bookingName"],
    editable: true,
    canDisable: true,
  },
  {
    key: "booking_checkin_reminder",
    name: "Return reminder",
    description: "Sent before equipment is due back.",
    category: "Returns",
    subject: "Return reminder: {{itemName}}",
    body: "Hi {{displayName}},\n\n{{itemName}}{{unitNumber}} is due back on {{dueDate}}.\n\nPlease return it by then, or request an extension from My Loans.\n\n{{ioioOpeningHours}}\n\nIOIO Lab",
    variables: [
      "displayName",
      "itemName",
      "unitNumber",
      "dueDate",
      "ioioOpeningHours",
    ],
    editable: true,
    canDisable: true,
  },
  {
    key: "booking_checkout_reminder",
    name: "Borrowing reminder",
    description:
      "Sent when equipment is ready for the planned borrowing period.",
    category: "Borrowing",
    subject: "Borrowing reminder: {{bookingName}}",
    body: "Hi {{displayName}},\n\nYour planned borrowing period for {{bookingName}} starts on {{startDate}}.\n\nPlease collect the equipment during IOIO Lab opening hours.\n\nIOIO Lab",
    variables: ["displayName", "bookingName", "startDate"],
    editable: true,
    canDisable: true,
  },
  {
    key: "ready_for_pickup",
    name: "Ready for pickup",
    description: "Sent when Staff has prepared equipment for collection.",
    category: "Borrowing",
    subject: "{{itemName}} is ready for pickup",
    body: "Hi {{displayName}},\n\n{{itemName}}{{unitNumber}} is ready for pickup.\n\nPickup location: {{pickupLocation}}\nPickup hours: {{pickupHours}}{{staffComment}}\n\nIOIO Lab",
    variables: [
      "displayName",
      "itemName",
      "unitNumber",
      "pickupLocation",
      "pickupHours",
      "staffComment",
    ],
    editable: true,
    canDisable: true,
  },
  {
    key: "account_invitation",
    name: "Account invitation",
    description: "Sent when someone is invited to join the IOIO Lab workspace.",
    category: "Account",
    subject: "You have been invited to {{organizationName}}",
    body: "Hi {{displayName}},\n\nYou have been invited to join {{organizationName}} in IOIO Lab.\n\nUse the invitation link in this email to continue.\n\nIOIO Lab",
    variables: ["organizationName", "displayName"],
    editable: false,
    canDisable: false,
  },
] satisfies EmailTemplateDefinition[];

export const PASSWORD_RESET_NOTE =
  "Email verification and password reset messages are managed by Supabase Auth.";

export function getEmailTemplateDefinition(key: string) {
  return EMAIL_TEMPLATE_DEFINITIONS.find(
    (definition) => definition.key === key
  );
}
