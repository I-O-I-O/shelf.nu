import { useEffect, useMemo, useRef, useState } from "react";
import { OrganizationType } from "@prisma/client";
import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import { data, Form, useLoaderData } from "react-router";
import { ErrorContent } from "~/components/errors";
import type { HeaderData } from "~/components/layout/header/types";
import { Button } from "~/components/shared/button";
import { EMAIL_FOOTER_MAX_LENGTH } from "~/modules/email-footer/constants";
import { processEmailFooter } from "~/modules/email-footer/email-footer-validator.server";
import {
  EMAIL_TEMPLATE_CATEGORY_ORDER,
  EMAIL_TEMPLATE_DEFINITIONS,
  PASSWORD_RESET_NOTE,
  type EmailTemplateCategory,
} from "~/modules/email-templates/definitions";
import {
  getEmailTemplatesForOrganization,
  restoreEmailTemplate,
  saveEmailTemplate,
} from "~/modules/email-templates/service.server";
import { requireIoioStaffAccess } from "~/modules/ioio-staff/access.server";
import { updateOrganization } from "~/modules/organization/service.server";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import { sendNotification } from "~/utils/emitter/send-notification.server";
import { getEnv } from "~/utils/env";
import { ShelfError, makeShelfError } from "~/utils/error";
import { payload, error } from "~/utils/http.server";
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.data";
import { requirePermission } from "~/utils/roles.server";

export async function loader({ context, request }: LoaderFunctionArgs) {
  const authSession = context.getSession();
  const { userId } = authSession;

  try {
    const { currentOrganization, organizationId } = await requirePermission({
      userId,
      request,
      entity: PermissionEntity.emailSettings,
      action: PermissionAction.read,
    });

    if (currentOrganization.type === OrganizationType.PERSONAL) {
      throw new ShelfError({
        cause: null,
        title: "Not allowed",
        message: "Email settings are not available for personal workspaces.",
        label: "Settings",
        shouldBeCaptured: false,
        status: 403,
      });
    }

    const header: HeaderData = { title: "Emails" };
    const templates = await getEmailTemplatesForOrganization(organizationId);
    const smtpHost = getEnv("SMTP_HOST", { isRequired: false }) || "";
    const smtpFrom = getEnv("SMTP_FROM", { isRequired: false }) || "";
    const sender = parseSender(smtpFrom);

    return payload({
      header,
      organization: {
        name: currentOrganization.name,
        customEmailFooter: currentOrganization.customEmailFooter,
      },
      delivery: {
        senderName: sender.name || "Provider default",
        senderAddress: sender.address || "Provider default",
        provider: smtpHost ? "SMTP" : "Not configured",
        configured: Boolean(smtpHost && smtpFrom),
      },
      templates,
    });
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    throw data(error(reason), { status: reason.status });
  }
}

export const handle = { breadcrumb: () => "Emails" };

export const meta: MetaFunction<typeof loader> = ({ data }) => [
  { title: data ? appendToMetaTitle(data.header.title) : "" },
];

export const ErrorBoundary = () => <ErrorContent />;

function getText(formData: FormData, name: string) {
  const value = formData.get(name);
  return typeof value === "string" ? value.trim() : "";
}

function parseSender(value: string) {
  const match = value.match(/^\s*"?([^"<]*)"?\s*<([^>]+)>\s*$/);
  if (match) {
    return { name: match[1].trim(), address: match[2].trim() };
  }

  return { name: "", address: value.trim() };
}

export async function action({ context, request }: ActionFunctionArgs) {
  const authSession = context.getSession();
  const { userId } = authSession;

  try {
    await requireIoioStaffAccess({ context, request });
    const { organizationId } = await requirePermission({
      userId,
      request,
      entity: PermissionEntity.emailSettings,
      action: PermissionAction.update,
    });
    const formData = await request.formData();
    const intent = getText(formData, "intent");

    if (intent === "save-footer") {
      const footer = getText(formData, "customEmailFooter");
      const result = processEmailFooter(footer);
      if (!result.success) {
        return data(
          error(
            new ShelfError({
              cause: null,
              message: result.error || "Invalid email footer",
              label: "Settings",
              shouldBeCaptured: false,
              status: 400,
            })
          ),
          { status: 400 }
        );
      }

      await updateOrganization({
        id: organizationId,
        userId,
        customEmailFooter: result.message,
      });
      sendNotification({
        title: "Settings updated",
        message: "Email footer has been updated successfully",
        icon: { name: "success", variant: "success" },
        senderId: userId,
      });
      return payload({ success: true, updated: "footer" });
    }

    const key = getText(formData, "templateKey");
    const definition = EMAIL_TEMPLATE_DEFINITIONS.find(
      (item) => item.key === key
    );
    if (!definition || !definition.editable) {
      return data(
        error(
          new ShelfError({
            cause: null,
            message: "This email template cannot be edited.",
            label: "Settings",
            shouldBeCaptured: false,
            status: 400,
          })
        ),
        { status: 400 }
      );
    }

    if (intent === "restore-template") {
      await restoreEmailTemplate(organizationId, key);
      return payload({ success: true, updated: key });
    }

    if (intent === "save-template" || intent === "toggle-template") {
      const subject = getText(formData, "subject");
      const body = getText(formData, "body");
      const enabled = definition.canDisable
        ? formData.get("enabled") === "on"
        : true;
      if (!subject || !body) {
        return data(
          error(
            new ShelfError({
              cause: null,
              message: "Subject and body are required.",
              label: "Settings",
              shouldBeCaptured: false,
              status: 400,
            })
          ),
          { status: 400 }
        );
      }

      await saveEmailTemplate({
        organizationId,
        key,
        name: definition.name,
        subject,
        body,
        enabled,
      });
      return payload({ success: true, updated: key });
    }

    return data(
      error(
        new ShelfError({
          cause: null,
          message: "Unsupported email settings action.",
          label: "Settings",
          shouldBeCaptured: false,
          status: 400,
        })
      ),
      { status: 400 }
    );
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    return data(error(reason), { status: reason.status });
  }
}

type Template = Awaited<
  ReturnType<typeof getEmailTemplatesForOrganization>
>[number];

function DeliveryValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
      <p className="text-xs font-medium uppercase tracking-wide text-gray-500">
        {label}
      </p>
      <p className="mt-1 break-words text-sm text-gray-900">{value}</p>
    </div>
  );
}

export default function EmailSettingsPage() {
  const { delivery, organization, templates } = useLoaderData<typeof loader>();
  const [category, setCategory] = useState<EmailTemplateCategory>("Borrowing");
  const [selectedKey, setSelectedKey] = useState(templates[0]?.key ?? "");
  const [footer, setFooter] = useState(organization.customEmailFooter ?? "");

  const categories = useMemo(
    () =>
      EMAIL_TEMPLATE_CATEGORY_ORDER.filter((item) =>
        templates.some((template) => template.category === item)
      ),
    [templates]
  );
  const visibleTemplates = templates.filter(
    (template) => template.category === category
  );
  const selected =
    templates.find((template) => template.key === selectedKey) ??
    visibleTemplates[0];

  useEffect(() => {
    if (!visibleTemplates.some((template) => template.key === selectedKey)) {
      setSelectedKey(visibleTemplates[0]?.key ?? "");
    }
  }, [selectedKey, visibleTemplates]);

  return (
    <div className="flex flex-col gap-8">
      <section className="rounded-xl border border-gray-200 bg-white p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">
              Email delivery
            </h2>
            <p className="mt-1 text-sm text-gray-600">
              Customize automatic emails sent by IOIO Lab.
            </p>
          </div>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <DeliveryValue
            label="Sender"
            value={
              delivery.configured
                ? `${delivery.senderName} <${delivery.senderAddress}>`
                : "Not configured"
            }
          />
          <DeliveryValue label="Provider" value={delivery.provider} />
          <DeliveryValue
            label="Status"
            value={delivery.configured ? "Configured" : "Not configured"}
          />
        </div>
        <p className="mt-4 text-xs text-gray-500">
          Authentication emails, including verification and password reset, are
          managed by Supabase Auth.
        </p>
      </section>

      <section className="rounded-xl border border-gray-200 bg-white p-5">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">
            Automatic email templates
          </h2>
          <p className="mt-1 text-sm text-gray-600">
            Customize supported workspace notifications. Missing or restored
            templates use the built-in default.
          </p>
        </div>

        <div
          className="mt-5 flex flex-wrap gap-2"
          aria-label="Email categories"
        >
          {categories.map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => setCategory(item)}
              className={`rounded-lg border px-3 py-2 text-sm font-medium ${
                category === item
                  ? "border-red-700 bg-red-700 text-white"
                  : "border-gray-200 bg-white text-gray-800 hover:bg-gray-50"
              }`}
            >
              {item}
            </button>
          ))}
        </div>

        <div className="mt-5 grid gap-6 lg:grid-cols-[260px_minmax(0,1fr)]">
          <div className="flex flex-col gap-2">
            {visibleTemplates.map((template) => (
              <button
                key={template.key}
                type="button"
                onClick={() => setSelectedKey(template.key)}
                className={`rounded-lg border p-3 text-left text-sm ${
                  selected?.key === template.key
                    ? "border-red-700 bg-red-700 text-white"
                    : "border-gray-200 hover:bg-gray-50"
                }`}
              >
                <span
                  className={`block font-medium ${
                    selected?.key === template.key
                      ? "text-white"
                      : "text-gray-900"
                  }`}
                >
                  {template.name}
                </span>
                <span
                  className={`mt-1 block text-xs leading-5 ${
                    selected?.key === template.key
                      ? "text-white/90"
                      : "text-gray-500"
                  }`}
                >
                  {template.description}
                </span>
                <span
                  className={`mt-2 inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${
                    selected?.key === template.key
                      ? "bg-white/20 text-white"
                      : !template.enabled
                      ? "bg-gray-100 text-gray-600"
                      : template.customized
                      ? "bg-blue-50 text-blue-700"
                      : "bg-gray-100 text-gray-600"
                  }`}
                >
                  {!template.enabled
                    ? "Disabled"
                    : template.customized
                    ? "Customized"
                    : "Default"}
                </span>
              </button>
            ))}
            <div className="mt-3 rounded-lg border border-gray-200 bg-gray-50 p-3 text-xs text-gray-600">
              <p className="font-medium text-gray-900">Authentication emails</p>
              <p className="mt-1">{PASSWORD_RESET_NOTE}</p>
            </div>
          </div>

          {selected ? (
            <TemplateEditor key={selected.key} template={selected} />
          ) : null}
        </div>
      </section>

      <section className="rounded-xl border border-gray-200 bg-white p-5">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">
            Custom email footer
          </h2>
          <p className="mt-1 text-sm text-gray-600">
            This message is appended to supported workspace emails.
          </p>
        </div>
        <Form method="post" className="mt-4 max-w-2xl space-y-3">
          <input type="hidden" name="intent" value="save-footer" />
          <textarea
            name="customEmailFooter"
            value={footer}
            maxLength={EMAIL_FOOTER_MAX_LENGTH}
            rows={4}
            onChange={(event) => setFooter(event.target.value)}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
            placeholder="Optional footer message"
          />
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-gray-500">
              {footer.length} / {EMAIL_FOOTER_MAX_LENGTH}
            </span>
            <Button type="submit">Save footer</Button>
          </div>
        </Form>
      </section>
    </div>
  );
}

function TemplateEditor({ template }: { template: Template }) {
  if (!template.editable) {
    return (
      <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 text-sm text-gray-600">
        <h3 className="font-semibold text-gray-900">{template.name}</h3>
        <p className="mt-2">
          This message uses the existing account service and is not editable
          from workspace settings.
        </p>
      </div>
    );
  }

  return (
    <div className="min-w-0 rounded-xl border border-gray-200 bg-white p-5">
      <EditableTemplateEditor template={template} />
    </div>
  );
}

function EditableTemplateEditor({ template }: { template: Template }) {
  const [subject, setSubject] = useState(template.subject);
  const [body, setBody] = useState(template.body);
  const [enabled, setEnabled] = useState(template.enabled);
  const [activeField, setActiveField] = useState<"subject" | "body">("body");
  const subjectRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  function insertVariable(variable: string) {
    const token = `{{${variable}}}`;
    const target =
      activeField === "subject" ? subjectRef.current : bodyRef.current;
    const currentValue = activeField === "subject" ? subject : body;
    const start = target?.selectionStart ?? currentValue.length;
    const end = target?.selectionEnd ?? start;
    const nextValue = `${currentValue.slice(
      0,
      start
    )}${token}${currentValue.slice(end)}`;

    if (activeField === "subject") {
      setSubject(nextValue);
    } else {
      setBody(nextValue);
    }

    window.requestAnimationFrame(() => {
      target?.focus();
      target?.setSelectionRange(start + token.length, start + token.length);
    });
  }

  return (
    <div className="min-w-0">
      <Form method="post" className="space-y-4">
        <input type="hidden" name="templateKey" value={template.key} />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="font-semibold text-gray-900">{template.name}</h3>
            <p className="mt-1 text-xs text-gray-500">
              Customize this automatic IOIO Lab email.
            </p>
          </div>
          {template.canDisable ? (
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input
                type="checkbox"
                name="enabled"
                checked={enabled}
                onChange={(event) => setEnabled(event.target.checked)}
                className="rounded border-gray-300 text-primary-600 focus:ring-primary-500"
              />
              Enabled
            </label>
          ) : (
            <span className="rounded-full bg-gray-100 px-3 py-1 text-xs font-medium text-gray-600">
              Required
            </span>
          )}
        </div>
        <label className="block text-sm font-medium text-gray-700">
          Subject
          <input
            ref={subjectRef}
            name="subject"
            value={subject}
            onFocus={() => setActiveField("subject")}
            onChange={(event) => setSubject(event.target.value)}
            maxLength={200}
            className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 font-normal text-gray-900 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
          />
        </label>
        <label className="block text-sm font-medium text-gray-700">
          Message
          <textarea
            ref={bodyRef}
            name="body"
            value={body}
            onFocus={() => setActiveField("body")}
            onChange={(event) => setBody(event.target.value)}
            rows={9}
            className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 font-normal text-gray-900 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
          />
        </label>
        <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs font-medium text-gray-800">
              Available variables
            </span>
            <span className="text-xs text-gray-500">
              Click to insert into{" "}
              {activeField === "subject" ? "Subject" : "Body"}
            </span>
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            {template.variables.map((variable) => (
              <button
                key={variable}
                type="button"
                onClick={() => insertVariable(variable)}
                className="rounded-md border border-gray-300 bg-white px-2 py-1 font-mono text-xs text-gray-700 hover:border-primary-400 hover:text-primary-700"
              >
                {`{{${variable}}}`}
              </button>
            ))}
          </div>
        </div>
        <Preview subject={subject} body={body} />
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            name="intent"
            value="restore-template"
            onClick={(event) => {
              if (
                !window.confirm(
                  "Restore this email template to its built-in default?"
                )
              ) {
                event.preventDefault();
              }
            }}
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700"
          >
            Restore default
          </button>
          <button
            type="submit"
            name="intent"
            value="save-template"
            className="rounded-lg bg-red-700 px-4 py-2 text-sm font-medium text-white hover:bg-red-800"
          >
            Save changes
          </button>
        </div>
      </Form>
    </div>
  );
}

function Preview({ subject, body }: { subject: string; body: string }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">
        Preview
      </p>
      <p className="mt-3 text-xs font-medium uppercase tracking-wide text-gray-500">
        Subject
      </p>
      <p className="mt-1 text-sm font-semibold text-gray-900">
        {renderSample(subject)}
      </p>
      <p className="mt-3 text-xs font-medium uppercase tracking-wide text-gray-500">
        Message
      </p>
      <p className="mt-1 whitespace-pre-wrap text-sm text-gray-700">
        {renderSample(body)}
      </p>
    </div>
  );
}

function renderSample(value: string) {
  const samples: Record<string, string> = {
    firstName: "Alex",
    lastName: "Student",
    displayName: "Alex Student",
    itemName: "Makey Makey Kit",
    unitNumber: " #003",
    quantity: "2",
    reservationTitle: "Interaction Design",
    bookingName: "Interaction Design",
    assetCount: "3",
    borrowDate: "18 Sep 2026",
    startDate: "20 Sep 2026",
    endDate: "25 Sep 2026",
    currentDueDate: "2 Oct 2026",
    dueDate: "2 Oct 2026",
    requestedDate: "9 Oct 2026",
    pickupLocation: "Kit Return Zone",
    pickupHours: "Mon-Fri, 09:00-16:00",
    ioioOpeningHours: "Mon-Fri, 09:00-16:00",
    staffComment: "",
    actionReason: "Return check needed",
    borrowerName: "Alex Student",
    issueType: "Missing part",
    returnLocation: "Kit Return Zone",
    staffName: "IOIO Staff",
    organizationName: "IOIO Lab",
  };
  return value.replace(
    /{{\s*([A-Za-z][A-Za-z0-9_]*)\s*}}/g,
    (_, key: string) => samples[key] ?? ""
  );
}
