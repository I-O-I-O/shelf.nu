import { useState } from "react";
import {
  data,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";
import { Form, Link, useActionData, useLoaderData } from "react-router";
import Header from "~/components/layout/header";
import { requireIoioStaffAccess } from "~/modules/ioio-staff/access.server";
import {
  buildLocationIntelligenceSnapshot,
  generateInventoryOrganizationProposal,
} from "~/modules/ioio-staff/location-intelligence.server";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import { makeShelfError } from "~/utils/error";
import { error, payload } from "~/utils/http.server";

export async function loader({ context, request }: LoaderFunctionArgs) {
  const { organizationId } = await requireIoioStaffAccess({ context, request });
  const snapshot = await buildLocationIntelligenceSnapshot(organizationId);
  return payload({
    header: { title: "Organize inventory" },
    categories: snapshot.categories,
    locations: snapshot.locations,
  });
}

export async function action({ context, request }: ActionFunctionArgs) {
  const { organizationId } = await requireIoioStaffAccess({ context, request });
  try {
    const form = await request.formData();
    const instruction = String(form.get("instruction") ?? "").trim();
    if (!instruction || instruction.length > 2_000)
      throw new Error(
        "Describe how you want to organize inventory (up to 2,000 characters)."
      );
    const categoryIds = form.get("categoryId")
      ? [String(form.get("categoryId"))]
      : undefined;
    const locationIds = form.get("locationId")
      ? [String(form.get("locationId"))]
      : undefined;
    return payload({
      kind: "proposal" as const,
      ...(await generateInventoryOrganizationProposal({
        organizationId,
        instruction,
        categoryIds,
        locationIds,
      })),
    });
  } catch (cause) {
    const reason = makeShelfError(cause);
    return data(error(reason), { status: reason.status });
  }
}

export const meta = () => [{ title: appendToMetaTitle("Organize inventory") }];
export const handle = {
  breadcrumb: () => <Link to="/staff/organize">Organize inventory</Link>,
};

export default function StaffOrganizePage() {
  const { categories, locations } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const [reviewState, setReviewState] = useState<
    Record<string, "kept" | "ignored">
  >({});
  const proposal =
    result && "kind" in result && result.kind === "proposal" ? result : null;
  return (
    <div>
      <Header hideQuickFind />
      <main className="mx-auto max-w-6xl px-4 py-6">
        <h1 className="text-2xl font-semibold">Organize inventory</h1>
        <p className="mt-2 text-sm text-gray-600">
          Describe the movement you want to review. Shelf builds a live
          inventory map and asks AI for bounded suggestions. Nothing is changed.
        </p>
        <Form
          method="post"
          className="mt-6 space-y-4 rounded-xl border border-gray-200 bg-white p-5"
        >
          <label className="block text-sm font-medium">
            What should we organize?
            <textarea
              required
              name="instruction"
              maxLength={2000}
              rows={4}
              placeholder="Find better locations for items currently in General Electronics."
              className="mt-2 block w-full rounded-md border border-gray-300 p-3 font-normal"
            />
          </label>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="text-sm">
              Category scope
              <select
                name="categoryId"
                defaultValue=""
                className="mt-1 block w-full rounded-md border border-gray-300 p-2"
              >
                <option value="">All categories</option>
                {categories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              Location scope
              <select
                name="locationId"
                defaultValue=""
                className="mt-1 block w-full rounded-md border border-gray-300 p-2"
              >
                <option value="">All locations</option>
                {locations.map((location) => (
                  <option key={location.id} value={location.id}>
                    {location.path}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <button className="rounded-md bg-red-700 px-4 py-2 text-sm font-semibold text-white">
            Analyze inventory
          </button>
        </Form>
        {proposal && (
          <section className="mt-8" aria-labelledby="proposal-title">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 id="proposal-title" className="text-xl font-semibold">
                Reorganization proposal
              </h2>
              <span className="rounded-full bg-amber-50 px-3 py-1 text-sm font-medium text-amber-800">
                Preview only · no changes made
              </span>
            </div>
            <p className="mt-1 text-sm text-gray-600">
              {proposal.proposalItems.length} suggested changes ·{" "}
              {proposal.diagnostics.modelsConsidered} models considered ·{" "}
              {proposal.diagnostics.modelsSentToClaude} sent across{" "}
              {proposal.diagnostics.batches} batches
            </p>
            {proposal.proposalItems.length ? (
              <div className="mt-4 overflow-x-auto rounded-lg border">
                <table className="w-full min-w-[900px] text-left text-sm">
                  <thead className="bg-gray-50">
                    <tr>
                      {[
                        "Product",
                        "Current category",
                        "Suggested category",
                        "Current location",
                        "Suggested location",
                        "Review",
                      ].map((heading) => (
                        <th key={heading} className="p-3 font-semibold">
                          {heading}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {proposal.proposalItems.map((item) => (
                      <tr key={item.modelId} className="border-t">
                        <td className="p-3 font-medium">
                          {item.productName}
                          <p className="mt-1 text-xs text-gray-500">
                            {item.reason}
                          </p>
                        </td>
                        <td className="p-3">
                          {categories.find(
                            (entry) => entry.id === item.currentCategoryId
                          )?.name ?? "Unassigned"}
                        </td>
                        <td className="p-3">
                          {item.categoryId
                            ? categories.find(
                                (entry) => entry.id === item.categoryId
                              )?.name ?? "Unresolved"
                            : "—"}
                        </td>
                        <td className="p-3">
                          {locations.find(
                            (entry) => entry.id === item.currentLocationId
                          )?.path ?? "Unassigned"}
                        </td>
                        <td className="p-3">
                          {item.locationId
                            ? locations.find(
                                (entry) => entry.id === item.locationId
                              )?.path ?? "Unresolved"
                            : "—"}
                        </td>
                        <td className="p-3">
                          <button
                            type="button"
                            onClick={() =>
                              setReviewState((prior) => ({
                                ...prior,
                                [item.modelId]: "kept",
                              }))
                            }
                            className="rounded border px-2 py-1"
                          >
                            {reviewState[item.modelId] === "kept"
                              ? "Kept"
                              : "Keep"}
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              setReviewState((prior) => ({
                                ...prior,
                                [item.modelId]: "ignored",
                              }))
                            }
                            className="ml-2 rounded border px-2 py-1"
                          >
                            {reviewState[item.modelId] === "ignored"
                              ? "Ignored"
                              : "Ignore"}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="mt-4 rounded-lg bg-gray-50 p-4 text-sm text-gray-600">
                {proposal.diagnostics.helperFailures > 0
                  ? "AI analysis could not complete for one or more batches. Check helper availability and try again."
                  : "No sufficiently confident changes were suggested."}
              </p>
            )}
          </section>
        )}
      </main>
    </div>
  );
}
