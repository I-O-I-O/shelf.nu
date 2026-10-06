import { Form, Link } from "react-router";
import { DateS } from "~/components/shared/date";

export type RecoverableCategory = {
  id: string;
  categoryId: string;
  name: string;
  description: string | null;
  color: string;
  archivedAt: string | Date;
  archivedBy: string;
  categoryExists: boolean;
};

type RecoverableCategoryListProps = {
  categories: RecoverableCategory[];
  mode: "archive" | "trash";
};

export function RecoverableCategoryList({
  categories,
  mode,
}: RecoverableCategoryListProps) {
  if (categories.length === 0) return null;

  return (
    <section className="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm">
      <div className="border-b border-gray-200 bg-gray-50 px-4 py-3">
        <h2 className="text-base font-bold text-gray-950">
          {mode === "archive" ? "Archived categories" : "Deleted categories"}
        </h2>
        <p className="mt-1 text-sm text-gray-600">
          Categories are kept separately from inventory items. Assets and kits
          remain in Inventory.
        </p>
      </div>
      <div className="divide-y divide-gray-200">
        {categories.map((category) => (
          <article
            key={category.id}
            className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="flex min-w-0 items-start gap-3">
              <span
                aria-hidden="true"
                className="mt-1 size-3 shrink-0 rounded-full"
                style={{ backgroundColor: category.color }}
              />
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  {category.categoryExists ? (
                    <Link
                      to={`/categories/${category.categoryId}/edit`}
                      className="break-words font-semibold text-gray-950 hover:text-red-700"
                    >
                      {category.name}
                    </Link>
                  ) : (
                    <span className="break-words font-semibold text-gray-950">
                      {category.name}
                    </span>
                  )}
                  <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-semibold text-gray-600">
                    Category
                  </span>
                </div>
                {category.description ? (
                  <p className="mt-1 break-words text-sm text-gray-600">
                    {category.description}
                  </p>
                ) : null}
                <p className="mt-2 text-xs text-gray-500">
                  {mode === "archive" ? "Archived" : "Deleted"}{" "}
                  <DateS date={category.archivedAt} />
                  <span aria-hidden="true"> · </span>
                  By {category.archivedBy}
                </p>
              </div>
            </div>

            <div className="flex shrink-0 flex-wrap gap-2 sm:justify-end">
              <Form method="post">
                <input
                  type="hidden"
                  name="categoryId"
                  value={category.categoryId}
                />
                <input type="hidden" name="intent" value="restore-category" />
                <button
                  type="submit"
                  className="rounded-lg border border-red-200 px-3 py-2 text-sm font-semibold text-red-700 transition hover:bg-red-50 focus:outline-none focus:ring-2 focus:ring-red-700 focus:ring-offset-2"
                >
                  Restore
                </button>
              </Form>
              {mode === "archive" ? (
                <Form method="post">
                  <input
                    type="hidden"
                    name="categoryId"
                    value={category.categoryId}
                  />
                  <input type="hidden" name="intent" value="trash-category" />
                  <button
                    type="submit"
                    className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-semibold text-gray-700 transition hover:border-red-300 hover:bg-red-50 hover:text-red-800 focus:outline-none focus:ring-2 focus:ring-red-700 focus:ring-offset-2"
                  >
                    Move to Trash
                  </button>
                </Form>
              ) : (
                <Form method="post">
                  <input
                    type="hidden"
                    name="categoryId"
                    value={category.categoryId}
                  />
                  <input
                    type="hidden"
                    name="intent"
                    value="delete-category-permanently"
                  />
                  <button
                    type="submit"
                    className="rounded-lg border border-red-600 bg-red-600 px-3 py-2 text-sm font-semibold text-white transition hover:border-red-800 hover:bg-red-800 focus:outline-none focus:ring-2 focus:ring-red-700 focus:ring-offset-2"
                  >
                    Delete permanently
                  </button>
                </Form>
              )}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
