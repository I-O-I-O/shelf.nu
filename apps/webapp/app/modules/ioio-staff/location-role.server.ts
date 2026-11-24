import { z } from "zod";

export const locationRoleSchema = z.enum([
  "ROOM",
  "SECTION",
  "SHELF",
  "CONTAINER",
  "DRAWER",
  "CABINET",
  "UNKNOWN",
]);
export type LocationRole = z.infer<typeof locationRoleSchema>;

/** Own-name evidence only: ancestor names and descriptions cannot change a role. */
export function inferLocationRole(location: { name: string }): LocationRole {
  const name = location.name.trim();
  const match =
    /^(section|shelf|container|drawer|cabinet)\s+[a-z0-9][a-z0-9.-]*$/i.exec(
      name
    );
  if (match) return locationRoleSchema.parse(match[1]!.toUpperCase());
  if (/\b(room|lab|laboratory)\b(?:\s*-\s*[a-z0-9-]+)?$/i.test(name))
    return "ROOM";
  return "UNKNOWN";
}
