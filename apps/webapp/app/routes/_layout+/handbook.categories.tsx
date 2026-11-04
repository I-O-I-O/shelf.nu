import { useEffect, useState } from "react";
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
  HandbookValidationError,
  createHandbookCategory,
  listHandbookCategoriesForManagement,
  renameHandbookCategory,
} from "~/modules/ioio-handbook/service.server";
import { requireIoioStaffAccess } from "~/modules/ioio-staff/access.server";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import { makeShelfError, ShelfError } from "~/utils/error";
import { error, payload } from "~/utils/http.server";

export async function loader({ context, request }: LoaderFunctionArgs) {
  const { userId } = context.getSession();
  try {
    const auth = await requireIoioStaffAccess({ context, request });
    if (auth.currentOrganization.type === "PERSONAL") {
      throw new ShelfError({
        cause: null,
        message:
          "Handbook categories are available in IOIO Lab workspaces only.",
        label: "Handbook",
        status: 403,
        shouldBeCaptured: false,
      });
    }
    const categories = await listHandbookCategoriesForManagement(
      auth.organizationId
    );
    return payload({ categories });
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    throw data(error(reason), { status: reason.status });
  }
}

export async function action({ context, request }: ActionFunctionArgs) {
  const auth = await requireIoioStaffAccess({ context, request });
  if (auth.currentOrganization.type === "PERSONAL") {
    return data(
      {
        success: false as const,
        intent: "",
        message:
          "Handbook categories are available in IOIO Lab workspaces only.",
      },
      { status: 403 }
    );
  }
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  try {
    if (intent === "create-category") {
      const category = await createHandbookCategory({
        organizationId: auth.organizationId,
        name: String(form.get("name") ?? ""),
      });
      return payload({
        success: true as const,
        intent,
        message: category.alreadyExists
          ? `“${category.name}” already exists in this Handbook.`
          : `Added “${category.name}” to this Handbook.`,
      });
    }
    if (intent === "rename-category") {
      const category = await renameHandbookCategory({
        organizationId: auth.organizationId,
        categoryId: String(form.get("categoryId") ?? ""),
        name: String(form.get("name") ?? ""),
      });
      return payload({
        success: true as const,
        intent,
        message: category.unchanged
          ? `“${category.name}” is already the category name.`
          : `Renamed category to “${category.name}”.`,
      });
    }
    return payload({
      success: false as const,
      intent,
      message: "Choose whether to add or rename a Handbook category.",
    });
  } catch (cause) {
    if (cause instanceof HandbookValidationError) {
      return payload({
        success: false as const,
        intent,
        message: cause.message,
      });
    }
    const reason = makeShelfError(cause, { userId: auth.userId });
    throw data(error(reason), { status: reason.status });
  }
}

export const meta: MetaFunction = () => [
  { title: appendToMetaTitle("Handbook categories") },
];
export const handle = { breadcrumb: () => "Categories" };

export default function HandbookCategoriesPage() {
  const { categories } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const [adding, setAdding] = useState(false);
  const busy = navigation.state === "submitting";

  useEffect(() => {
    if (actionData?.success && actionData.intent === "create-category") {
      setAdding(false);
    }
  }, [actionData]);

  return (
    <main className="mx-auto max-w-5xl px-4 py-6 sm:px-6 lg:px-8">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <Link
            to="/handbook"
            className="text-sm font-semibold text-red-800 hover:underline"
          >
            ← Handbook
          </Link>
          <h1 className="mt-2 text-2xl font-semibold text-gray-950">
            Handbook categories
          </h1>
          <p className="mt-1 text-sm text-gray-600">
            Manage categories used by Handbook articles. These are separate from
            Shelf asset categories.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setAdding((current) => !current)}
          className="inline-flex h-10 items-center rounded-lg bg-red-700 px-4 text-sm font-semibold text-white hover:bg-red-800"
        >
          Add category
        </button>
      </header>

      {actionData?.message ? (
        <p
          role={actionData.success ? "status" : "alert"}
          className={
            actionData.success
              ? "mb-4 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-900"
              : "mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900"
          }
        >
          {actionData.message}
        </p>
      ) : null}

      {adding ? (
        <Form
          method="post"
          className="mb-5 rounded-xl border border-gray-200 bg-white p-4 shadow-sm"
        >
          <input type="hidden" name="intent" value="create-category" />
          <label className="block text-sm font-semibold text-gray-800">
            Name
            <input
              required
              name="name"
              maxLength={80}
              autoFocus
              className="mt-1 block h-10 w-full rounded-lg border border-gray-300 px-3 font-normal focus:border-red-700 focus:outline-none focus:ring-2 focus:ring-red-100"
            />
          </label>
          <div className="mt-3 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setAdding(false)}
              className="inline-flex h-9 items-center rounded-lg border border-gray-300 px-3 text-sm font-semibold text-gray-700 hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              disabled={busy}
              className="inline-flex h-9 items-center rounded-lg bg-red-700 px-3 text-sm font-semibold text-white disabled:opacity-60"
            >
              Add category
            </button>
          </div>
        </Form>
      ) : null}

      <section className="rounded-xl border border-gray-200 bg-white">
        {categories.length ? (
          <ul className="divide-y divide-gray-100">
            {categories.map((category) => (
              <li key={category.id} className="p-4">
                <Form method="post" className="flex flex-wrap items-end gap-3">
                  <input type="hidden" name="intent" value="rename-category" />
                  <input type="hidden" name="categoryId" value={category.id} />
                  <label className="min-w-56 flex-1 text-sm font-semibold text-gray-800">
                    Category name
                    <input
                      required
                      name="name"
                      maxLength={80}
                      defaultValue={category.name}
                      aria-label={`Name for ${category.name}`}
                      className="mt-1 block h-10 w-full rounded-lg border border-gray-300 px-3 font-normal focus:border-red-700 focus:outline-none focus:ring-2 focus:ring-red-100"
                    />
                  </label>
                  <p className="pb-2 text-sm text-gray-600">
                    {category._count.articles}{" "}
                    {category._count.articles === 1 ? "article" : "articles"}
                  </p>
                  <button
                    disabled={busy}
                    className="inline-flex h-9 items-center rounded-lg border border-gray-300 px-3 text-sm font-semibold text-gray-800 hover:bg-gray-50 disabled:opacity-60"
                  >
                    Rename
                  </button>
                </Form>
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-4 py-6 text-sm text-gray-600">
            No Handbook categories yet. Add the first one here or create it
            inline while writing an article.
          </p>
        )}
      </section>
    </main>
  );
}

export const ErrorBoundary = () => <ErrorContent />;
