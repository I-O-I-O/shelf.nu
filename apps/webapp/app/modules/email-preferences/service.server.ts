import { db } from "~/database/db.server";

export const EMAIL_PREFERENCE_CATEGORIES = [
  "BORROWING_CONFIRMATION",
  "RETURN_REMINDER",
  "EXTENSION_UPDATE",
  "READY_FOR_PICKUP",
  "CARD_ACCESS_UPDATE",
  "ANNUAL_ACCESS_UPDATE",
] as const;

export type EmailPreferenceCategory =
  (typeof EMAIL_PREFERENCE_CATEGORIES)[number];

type PreferenceField =
  | "borrowingConfirmation"
  | "returnReminders"
  | "extensionUpdates"
  | "readyForPickup"
  | "cardAccessUpdates"
  | "annualAccessUpdates";

const categoryFields: Record<EmailPreferenceCategory, PreferenceField> = {
  BORROWING_CONFIRMATION: "borrowingConfirmation",
  RETURN_REMINDER: "returnReminders",
  EXTENSION_UPDATE: "extensionUpdates",
  READY_FOR_PICKUP: "readyForPickup",
  CARD_ACCESS_UPDATE: "cardAccessUpdates",
  ANNUAL_ACCESS_UPDATE: "annualAccessUpdates",
};

export const defaultEmailPreferences = {
  borrowingConfirmation: true,
  returnReminders: true,
  extensionUpdates: true,
  readyForPickup: true,
  cardAccessUpdates: true,
  annualAccessUpdates: true,
};

export async function getUserEmailPreferences(userId: string) {
  const preferences = await db.userEmailPreference.findUnique({
    where: { userId },
    select: {
      borrowingConfirmation: true,
      returnReminders: true,
      extensionUpdates: true,
      readyForPickup: true,
      cardAccessUpdates: true,
      annualAccessUpdates: true,
    },
  });

  return { ...defaultEmailPreferences, ...preferences };
}

export async function shouldSendOptionalEmail(
  userId: string,
  category: EmailPreferenceCategory
) {
  const preferences = await getUserEmailPreferences(userId);
  return preferences[categoryFields[category]];
}

export async function updateUserEmailPreference(
  userId: string,
  category: EmailPreferenceCategory,
  enabled: boolean
) {
  const field = categoryFields[category];
  return db.userEmailPreference.upsert({
    where: { userId },
    create: { userId, [field]: enabled },
    update: { [field]: enabled },
    select: {
      borrowingConfirmation: true,
      returnReminders: true,
      extensionUpdates: true,
      readyForPickup: true,
      cardAccessUpdates: true,
      annualAccessUpdates: true,
    },
  });
}
