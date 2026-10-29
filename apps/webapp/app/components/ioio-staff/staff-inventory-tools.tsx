import { Button } from "~/components/shared/button";

export function StaffInventoryTools() {
  return (
    <section aria-labelledby="inventory-tools-heading" className="space-y-4">
      <div>
        <h2
          id="inventory-tools-heading"
          className="text-xl font-black text-gray-950 dark:text-gray-50"
        >
          Inventory tools
        </h2>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
          Choose a focused tool to bring in inventory or improve where it is
          stored.
        </p>
      </div>

      <div className="grid min-w-0 gap-4 sm:grid-cols-2">
        <article className="min-w-0 rounded-2xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-900 sm:p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="text-lg font-bold text-gray-950 dark:text-gray-50">
                Import inventory
              </h3>
              <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
                Turn supplier documents and inventory files into a reviewed
                Shelf import proposal.
              </p>
            </div>
            <Button to="/staff/import" variant="primary" size="sm">
              Import inventory
            </Button>
          </div>

          <p className="mt-3 text-sm text-gray-700 dark:text-gray-300">
            Works with <span className="font-semibold">PDF, CSV and XLSX</span>:
            it extracts products and quantities, normalizes names, matches
            existing inventory, and suggests existing categories and locations.
            Staff can correct rows before Apply.
          </p>

          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <div>
              <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                Works best for
              </h4>
              <ul className="mt-1 list-inside list-disc space-y-1 text-sm text-gray-600 dark:text-gray-300">
                <li>Supplier files and stock sheets</li>
                <li>Adding new inventory</li>
              </ul>
            </div>
            <div>
              <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                Current limitations
              </h4>
              <ul className="mt-1 list-inside list-disc space-y-1 text-sm text-gray-600 dark:text-gray-300">
                <li>Review suggestions; ambiguous rows may need correction.</li>
                <li>
                  Uses existing categories and locations. It does not reorganize
                  inventory or create storage structure.
                </li>
                <li>Suggested descriptions and images may not be a match.</li>
                <li>Nothing is created until staff approves Apply.</li>
              </ul>
            </div>
          </div>
        </article>

        <article className="min-w-0 rounded-2xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-900 sm:p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="text-lg font-bold text-gray-950 dark:text-gray-50">
                Organize inventory
              </h3>
              <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
                Review existing Shelf inventory and storage, then propose
                placement or structure improvements.
              </p>
            </div>
            <Button to="/staff/organize" variant="primary" size="sm">
              Organize inventory
            </Button>
          </div>

          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <div>
              <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                Works best for
              </h4>
              <ul className="mt-1 list-inside list-disc space-y-1 text-sm text-gray-600 dark:text-gray-300">
                <li>Asking what is stored in a location</li>
                <li>
                  Finding better existing locations for named or selected
                  products
                </li>
                <li>Reviewing placement recommendations</li>
                <li>Creating simple rooms, sections, shelves or containers</li>
                <li>Proposing removal of eligible empty locations</li>
              </ul>
              <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                Examples: “Where should Arduino Nano go?”, “Find better
                locations for these selected items”, “Create 5 shelves under
                Section C”, or “Show what is stored in Section A.”
              </p>
            </div>
            <div>
              <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                Current limitations
              </h4>
              <ul className="mt-1 list-inside list-disc space-y-1 text-sm text-gray-600 dark:text-gray-300">
                <li>
                  One main goal per request works best. Split requests to delete
                  containers, create shelves and move products into separate
                  steps.
                </li>
                <li>
                  Organize recommends better locations; it does not move
                  products. Review and approve moves through Shelf.
                </li>
                <li>
                  Recommendations use Shelf records, not measured container
                  capacity.
                </li>
              </ul>
            </div>
          </div>
        </article>
      </div>

      <aside
        aria-labelledby="inventory-tools-ai-heading"
        className="rounded-xl border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-800"
      >
        <h3
          id="inventory-tools-ai-heading"
          className="text-sm font-semibold text-gray-900 dark:text-gray-100"
        >
          How the AI works
        </h3>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
          AI helps interpret documents and staff requests. Shelf remains the
          source of truth and validates categories, locations, permissions and
          changes before anything is applied.
        </p>
      </aside>
    </section>
  );
}
