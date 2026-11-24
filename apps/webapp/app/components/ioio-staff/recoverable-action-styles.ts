export const recoverableRestoreActionClassName =
  "rounded-lg border border-red-200 px-3 py-2 text-sm font-semibold text-red-700 transition hover:bg-red-50 focus:outline-none focus:ring-2 focus:ring-red-700 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-40";

export const recoverableDestructiveActionClassName =
  "rounded-lg border border-red-600 bg-red-600 px-3 py-2 text-sm font-semibold text-white transition hover:border-red-800 hover:bg-red-800 focus:outline-none focus:ring-2 focus:ring-red-700 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-40";

export const recoverablePermanentDeleteActionClassName =
  recoverableDestructiveActionClassName;

export const recoverableTrashActionClassName =
  recoverableDestructiveActionClassName;
