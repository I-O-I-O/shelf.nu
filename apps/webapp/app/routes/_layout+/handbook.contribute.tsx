import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import {
  data,
  Form,
  Link,
  useActionData,
  useLoaderData,
  useNavigation,
} from "react-router";
import { ErrorContent } from "~/components/errors";
import {
  getHandbookContributionOptions,
  HandbookValidationError,
  submitHandbookObservation,
} from "~/modules/ioio-handbook/service.server";
import { requireStudentRead } from "~/modules/ioio-student/route.server";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import { makeShelfError } from "~/utils/error";
import { error, payload } from "~/utils/http.server";

export async function loader({ context, request }: LoaderFunctionArgs) {
  const { userId } = context.getSession();
  try {
    const auth = await requireStudentRead({ context, request });
    return payload(await getHandbookContributionOptions(auth.organizationId));
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    throw data(error(reason), { status: reason.status });
  }
}

export async function action({ context, request }: ActionFunctionArgs) {
  const auth = await requireStudentRead({ context, request });
  const form = await request.formData();
  const title = String(form.get("title") ?? "").trim();
  const content = String(form.get("content") ?? "").trim();
  if (!title || !content || title.length > 180 || content.length > 4000) {
    return payload({
      success: false as const,
      message: "Add a short title and details (up to 4,000 characters).",
    });
  }
  try {
    const result = await submitHandbookObservation({
      organizationId: auth.organizationId,
      userId: auth.userId,
      title,
      content,
      articleId: String(form.get("articleId") ?? "") || undefined,
      assetModelId: String(form.get("assetModelId") ?? "") || undefined,
      kitId: String(form.get("kitId") ?? "") || undefined,
    });
    return payload({
      success: true as const,
      message: result.duplicate
        ? `This matches existing Handbook knowledge, “${result.duplicateTitle}”. No duplicate contribution was created.`
        : "Saved as a contribution for Staff review. It has not changed the Handbook.",
      related: result.related,
    });
  } catch (cause) {
    if (cause instanceof HandbookValidationError)
      return payload({ success: false as const, message: cause.message });
    const reason = makeShelfError(cause, { userId: auth.userId });
    throw data(error(reason), { status: reason.status });
  }
}

export const meta: MetaFunction = () => [
  { title: appendToMetaTitle("Contribute to the Handbook") },
];
export const handle = { breadcrumb: () => "Contribute knowledge" };

export default function HandbookContributionPage() {
  const { articles, assetModels, kits } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const navigation = useNavigation();
  const successful = Boolean(result && "success" in result && result.success);
  const related =
    result && "success" in result && result.success && "related" in result
      ? result.related
      : [];
  return (
    <main className="mx-auto max-w-3xl px-4 py-6 sm:px-6 lg:px-8">
      <Link
        to="/handbook"
        className="text-sm font-semibold text-red-800 hover:underline"
      >
        ← Handbook
      </Link>
      <h1 className="mt-3 text-2xl font-semibold text-gray-950">
        Contribute knowledge
      </h1>
      <p className="mt-2 text-sm leading-6 text-gray-600">
        Share a practical discovery, recurring issue, correction, or procedure.
        This is sent to Staff for review and does not publish or change official
        guidance.
      </p>
      {result && "message" in result ? (
        <div
          role={successful ? "status" : "alert"}
          className={
            successful
              ? "mt-4 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-900"
              : "mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900"
          }
        >
          {result.message}
        </div>
      ) : null}
      {related.length ? (
        <section className="mt-4 rounded-lg border border-blue-200 bg-blue-50 p-4">
          <h2 className="text-sm font-semibold text-blue-950">
            Potentially related stored knowledge
          </h2>
          <p className="mt-1 text-xs text-blue-900">
            These are lexical matches from saved Handbook pages or observations,
            not proof that the reports are identical.
          </p>
          <ul className="mt-2 space-y-1 text-sm text-blue-950">
            {related.map((item, index) => (
              <li key={item.kind + "-" + item.title + "-" + index}>
                {item.kind === "article"
                  ? "Published Handbook · " + item.section + " · " + item.title
                  : "Observation · " + item.title + " · " + item.status}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <Form
        method="post"
        className="mt-5 space-y-4 rounded-xl border border-gray-200 bg-white p-4 shadow-sm sm:p-6"
      >
        <label className="block text-sm font-semibold text-gray-800">
          Short title
          <input
            required
            name="title"
            maxLength={180}
            className="mt-1 block h-10 w-full rounded-lg border border-gray-300 px-3 font-normal focus:border-red-700 focus:outline-none focus:ring-2 focus:ring-red-100"
            placeholder="e.g. Grove cable connection issue"
          />
        </label>
        <label className="block text-sm font-semibold text-gray-800">
          What did you observe or learn?
          <textarea
            required
            name="content"
            maxLength={4000}
            rows={7}
            className="mt-1 block w-full rounded-lg border border-gray-300 p-3 font-normal leading-6 focus:border-red-700 focus:outline-none focus:ring-2 focus:ring-red-100"
            placeholder="Include what happened, which equipment it involved, what you tried, and what worked."
          />
        </label>
        <div className="grid gap-4 sm:grid-cols-3">
          <label className="block text-sm font-semibold text-gray-800">
            Related Handbook page
            <select
              name="articleId"
              defaultValue=""
              className="mt-1 block h-10 w-full rounded-lg border border-gray-300 bg-white px-2 text-sm font-normal"
            >
              <option value="">None</option>
              {articles.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm font-semibold text-gray-800">
            Related product
            <select
              name="assetModelId"
              defaultValue=""
              className="mt-1 block h-10 w-full rounded-lg border border-gray-300 bg-white px-2 text-sm font-normal"
            >
              <option value="">None</option>
              {assetModels.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm font-semibold text-gray-800">
            Related Kit
            <select
              name="kitId"
              defaultValue=""
              className="mt-1 block h-10 w-full rounded-lg border border-gray-300 bg-white px-2 text-sm font-normal"
            >
              <option value="">None</option>
              {kits.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="flex justify-end">
          <button
            type="submit"
            disabled={navigation.state === "submitting"}
            className="inline-flex h-10 items-center rounded-lg bg-red-700 px-4 text-sm font-semibold text-white hover:bg-red-800 disabled:opacity-60"
          >
            {navigation.state === "submitting"
              ? "Submitting…"
              : "Send for Staff review"}
          </button>
        </div>
      </Form>
    </main>
  );
}

export const ErrorBoundary = () => <ErrorContent />;
