import { createHash } from "node:crypto";

/**
 * Returns an opaque browser-storage scope. The user and organization IDs stay
 * server-side while chat history remains separated per account and role.
 */
export function getIoioChatScope(
  userId: string,
  organizationId: string,
  role: string
) {
  return createHash("sha256")
    .update(`ioio-chat:${role}:${organizationId}:${userId}`)
    .digest("hex")
    .slice(0, 24);
}
