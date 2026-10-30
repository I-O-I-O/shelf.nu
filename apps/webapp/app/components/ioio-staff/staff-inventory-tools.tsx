import { Button } from "~/components/shared/button";

const inventoryTools = [
  {
    title: "Import",
    description: "Add inventory from PDF, CSV, or Excel files.",
    href: "/staff/import",
    action: "Import inventory",
  },
  {
    title: "Organize",
    description:
      "Review existing inventory, find better locations, and plan simple storage changes.",
    href: "/staff/organize",
    action: "Organize",
  },
] as const;

export function StaffInventoryTools() {
  return (
    <section
      aria-label="Inventory shortcuts"
      className="grid min-w-0 items-stretch gap-4 sm:grid-cols-2"
    >
      {inventoryTools.map((tool) => (
        <article
          key={tool.title}
          className="flex h-full min-w-0 flex-col rounded-2xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-900 sm:p-5"
        >
          <h2 className="text-lg font-bold text-gray-950 dark:text-gray-50">
            {tool.title}
          </h2>
          <p className="mt-1 flex-1 text-sm text-gray-600 dark:text-gray-300">
            {tool.description}
          </p>
          <div className="mt-auto pt-4">
            <Button to={tool.href} variant="primary" size="sm">
              {tool.action}
            </Button>
          </div>
        </article>
      ))}
    </section>
  );
}
