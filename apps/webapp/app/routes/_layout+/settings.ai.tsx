import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { data, Outlet } from "react-router";
import { ErrorContent } from "~/components/errors";
import HorizontalTabs from "~/components/layout/horizontal-tabs";
import { requireIoioStaffAccess } from "~/modules/ioio-staff/access.server";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import { ShelfError, makeShelfError } from "~/utils/error";
import { error } from "~/utils/http.server";

export async function loader({ context, request }: LoaderFunctionArgs) {
  const { userId } = context.getSession();
  try {
    const { currentOrganization } = await requireIoioStaffAccess({
      context,
      request,
    });
    if (currentOrganization.type === "PERSONAL") {
      throw new ShelfError({
        cause: null,
        message: "AI settings are available in IOIO Lab workspaces only.",
        label: "Settings",
        status: 403,
        shouldBeCaptured: false,
      });
    }
    return null;
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    throw data(error(reason), { status: reason.status });
  }
}

export const handle = { breadcrumb: () => "AI" };
export const meta: MetaFunction = () => [{ title: appendToMetaTitle("AI") }];

export default function SettingsAiLayout() {
  return (
    <>
      <div className="mb-4 px-4">
        <h2 className="text-lg font-semibold text-gray-900">AI</h2>
        <p className="mt-1 text-sm text-gray-600">
          Tell Ask IOIO how you want it to help people.
        </p>
      </div>
      <HorizontalTabs
        items={[
          { to: "guidelines", content: "Guidelines" },
          { to: "knowledge", content: "Knowledge" },
        ]}
      />
      <Outlet />
    </>
  );
}

export const ErrorBoundary = () => <ErrorContent />;
