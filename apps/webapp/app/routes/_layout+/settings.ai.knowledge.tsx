import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { data, Link } from "react-router";
import { ErrorContent } from "~/components/errors";
import { requireIoioStaffAccess } from "~/modules/ioio-staff/access.server";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import { makeShelfError, ShelfError } from "~/utils/error";
import { error } from "~/utils/http.server";

export async function loader({ context, request }: LoaderFunctionArgs) {
  const { userId } = context.getSession();
  try {
    const auth = await requireIoioStaffAccess({ context, request });
    if (auth.currentOrganization.type === "PERSONAL")
      throw new ShelfError({
        cause: null,
        message:
          "AI knowledge settings are available in IOIO Lab workspaces only.",
        label: "Settings",
        status: 403,
        shouldBeCaptured: false,
      });
    return null;
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    throw data(error(reason), { status: reason.status });
  }
}

export const meta: MetaFunction = () => [
  { title: appendToMetaTitle("AI knowledge") },
];
export const handle = { breadcrumb: () => "Knowledge" };

export default function AiKnowledgePage() {
  return (
    <main className="mx-auto w-full max-w-5xl px-4 pb-8">
      <header className="mb-5">
        <h1 className="text-xl font-semibold text-gray-950">
          Ask IOIO knowledge
        </h1>
        <p className="mt-1 max-w-2xl text-sm text-gray-600">
          Ask IOIO uses published Handbook articles as its workshop knowledge
          source. Drafts and student contributions awaiting review are not
          included in answers.
        </p>
      </header>
      <section className="rounded-xl border border-gray-200 bg-white p-4">
        <h2 className="font-semibold text-gray-900">
          Published Handbook content
        </h2>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-gray-600">
          Ask IOIO can use current published versions to answer procedure and
          troubleshooting questions. Article publication and student review are
          managed in the Handbook.
        </p>
        <Link
          to="/handbook"
          className="mt-4 inline-flex h-10 items-center rounded-lg border border-gray-300 bg-white px-4 text-sm font-semibold text-gray-800 hover:bg-gray-50"
        >
          Open Handbook
        </Link>
      </section>
    </main>
  );
}

export const ErrorBoundary = () => <ErrorContent />;
