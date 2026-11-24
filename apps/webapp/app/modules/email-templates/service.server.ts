import type { EmailTemplate } from "@prisma/client";
import { db } from "~/database/db.server";
import { Logger } from "~/utils/logger";
import {
  EMAIL_TEMPLATE_DEFINITIONS,
  getEmailTemplateDefinition,
} from "./definitions";

export async function getEmailTemplatesForOrganization(organizationId: string) {
  const overrides = await db.emailTemplate.findMany({
    where: { organizationId },
  });
  const byKey = new Map(overrides.map((template) => [template.key, template]));

  return EMAIL_TEMPLATE_DEFINITIONS.map((definition) => {
    const override = byKey.get(definition.key);
    return {
      ...definition,
      id: override?.id ?? null,
      subject: override?.subject ?? definition.subject,
      body: override?.body ?? definition.body,
      enabled: override?.enabled ?? true,
      customized: Boolean(override),
    };
  });
}

export async function getResolvedEmailTemplate(
  organizationId: string,
  key: string
) {
  const definition = getEmailTemplateDefinition(key);
  if (!definition) return null;

  const override = await db.emailTemplate.findUnique({
    where: { organizationId_key: { organizationId, key } },
  });

  if (!override) {
    return null;
  }

  // An explicit disable must be respected even when an old/customized body
  // contains a variable that is no longer supported. The sender can then
  // safely skip this optional notification instead of silently sending the
  // built-in version.
  if (override.enabled === false) return override;

  if (
    !hasValidVariables(override.subject, override.body, definition.variables)
  ) {
    Logger.warn(
      `Ignoring invalid customized email template variables for ${key}; using the built-in default.`
    );
    return null;
  }

  return override;
}

export async function saveEmailTemplate({
  organizationId,
  key,
  name,
  subject,
  body,
  enabled,
}: {
  organizationId: string;
  key: string;
  name: string;
  subject: string;
  body: string;
  enabled: boolean;
}) {
  const definition = getEmailTemplateDefinition(key);
  if (!definition || !definition.editable) return;

  await db.emailTemplate.upsert({
    where: { organizationId_key: { organizationId, key } },
    create: {
      organizationId,
      key,
      name,
      category: definition.category,
      subject,
      body,
      enabled,
    },
    update: { name, subject, body, enabled },
  });
}

export async function restoreEmailTemplate(
  organizationId: string,
  key: string
) {
  await db.emailTemplate.deleteMany({ where: { organizationId, key } });
}

export function renderEmailTemplate(
  template: Pick<EmailTemplate, "subject" | "body">,
  values: Record<string, string | number>
) {
  const replace = (source: string) =>
    source.replace(/{{\s*([A-Za-z][A-Za-z0-9_]*)\s*}}/g, (_, key: string) =>
      String(values[key] ?? "")
    );

  return { subject: replace(template.subject), body: replace(template.body) };
}

function hasValidVariables(
  subject: string,
  body: string,
  allowedVariables: readonly string[]
) {
  const variables = `${subject}\n${body}`.matchAll(
    /{{\s*([A-Za-z][A-Za-z0-9_]*)\s*}}/g
  );
  return Array.from(variables).every((match) =>
    allowedVariables.includes(match[1])
  );
}
