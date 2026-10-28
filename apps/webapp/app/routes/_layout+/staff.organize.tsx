import { useState } from "react";
import {
  data,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";
import { Form, Link, useActionData, useLoaderData } from "react-router";
import Header from "~/components/layout/header";
import { requireIoioStaffAccess } from "~/modules/ioio-staff/access.server";
import { generateInventoryOrganizationProposal } from "~/modules/ioio-staff/location-intelligence.server";
import {
  buildLocationStructureProposal,
  classifyOrganizationRequest,
  createLocationStructure,
  getOrganizationLocationChoices,
} from "~/modules/ioio-staff/location-structure.server";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import { makeShelfError } from "~/utils/error";
import { error, payload } from "~/utils/http.server";
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.data";
import { requirePermission } from "~/utils/roles.server";

export async function loader({ context, request }: LoaderFunctionArgs) {
  const { organizationId } = await requireIoioStaffAccess({ context, request });
  const choices = await getOrganizationLocationChoices(organizationId);
  return payload({
    header: { title: "Organize inventory" },
    categories: choices.categories,
    locations: choices.locations,
  });
}

export async function action({ context, request }: ActionFunctionArgs) {
  const { organizationId, userId } = await requireIoioStaffAccess({
    context,
    request,
  });
  try {
    const form = await request.formData();
    const intent = String(form.get("intent") ?? "analyze");
    if (intent === "create-structure") {
      await requirePermission({
        userId,
        request,
        entity: PermissionEntity.location,
        action: PermissionAction.create,
      });
      const rawProposal = form.get("proposal");
      if (typeof rawProposal !== "string" || rawProposal.length > 100_000)
        throw new Error("Reload the structure proposal and review it again.");
      const result = await createLocationStructure({
        organizationId,
        userId,
        proposalInput: JSON.parse(rawProposal),
      });
      return payload({ kind: "structure-created" as const, result });
    }
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
    const classification = classifyOrganizationRequest(instruction);
    if (
      classification === "LOCATION_STRUCTURE" ||
      form.get("workflow") === "LOCATION_STRUCTURE"
    ) {
      return payload({
        kind: "structure-proposal" as const,
        proposal: await buildLocationStructureProposal({
          organizationId,
          instruction,
          selectedParentId:
            String(form.get("parentLocationId") ?? "") || undefined,
        }),
      });
    }
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
  const [dismissed, setDismissed] = useState(false);
  const proposal =
    result && "kind" in result && result.kind === "proposal" ? result : null;
  const structureProposal =
    result && "kind" in result && result.kind === "structure-proposal"
      ? result.proposal
      : null;
  const structureCreated =
    result && "kind" in result && result.kind === "structure-created"
      ? result.result
      : null;
  const structureApplyPayload = structureProposal
    ? {
        mode: structureProposal.mode,
        instruction: structureProposal.instruction,
        parentLocationId: structureProposal.parentLocationId,
        nodes: structureProposal.nodes,
      }
    : null;
  return (
    <div>
      <Header hideQuickFind />
      <main className="mx-auto max-w-6xl px-4 py-6">
        <h1 className="text-2xl font-semibold">Organize inventory</h1>
        <p className="mt-2 text-sm text-gray-600">
          Choose whether you want to reorganize inventory or plan locations.
          Storage structure requests never analyze inventory.
        </p>
        <Form
          method="post"
          className="mt-6 space-y-4 rounded-xl border border-gray-200 bg-white p-5"
        >
          <label className="block text-sm font-medium">
            What should we organize?
            <textarea
              id="organization-instruction"
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
          <div className="flex flex-wrap gap-3">
            <button
              name="workflow"
              value="INVENTORY_REORGANIZATION"
              className="rounded-md bg-red-700 px-4 py-2 text-sm font-semibold text-white"
            >
              Organize inventory
            </button>
            <button
              name="workflow"
              value="LOCATION_STRUCTURE"
              className="rounded-md border border-red-700 px-4 py-2 text-sm font-semibold text-red-800"
            >
              Create storage structure
            </button>
          </div>
        </Form>
        {structureCreated && (
          <section
            className="mt-8 rounded-xl border p-5"
            aria-label="Location creation results"
          >
            <h2 className="text-xl font-semibold">Storage structure results</h2>
            <p className="mt-1 text-sm">
              {structureCreated.createdCount} created ·{" "}
              {structureCreated.existingCount} already existed ·{" "}
              {structureCreated.failedCount} failed
            </p>
            <ul className="mt-4 space-y-2 text-sm">
              {structureCreated.results.map((item, index) => (
                <li
                  key={`${item.name}-${index}`}
                  className={item.status === "FAILED" ? "text-red-700" : ""}
                >
                  {item.status}: {item.path}
                  {item.error ? ` — ${item.error}` : ""}
                </li>
              ))}
            </ul>
          </section>
        )}
        {structureProposal && !dismissed && (
          <section
            className="mt-8 rounded-xl border p-5"
            aria-labelledby="structure-proposal-title"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2
                id="structure-proposal-title"
                className="text-xl font-semibold"
              >
                Storage structure proposal
              </h2>
              <span className="rounded-full bg-amber-50 px-3 py-1 text-sm font-medium text-amber-800">
                Preview only · no changes made
              </span>
            </div>
            {structureProposal.helperUnavailable && (
              <p className="mt-4 text-sm text-red-700">
                The structure assistant could not complete. Try a more explicit
                request or check helper availability.
              </p>
            )}
            {structureProposal.unresolvedParent &&
            structureProposal.parentCandidates.length > 1 ? (
              <div className="mt-4 rounded bg-amber-50 p-4">
                <p className="font-medium">
                  Choose which “{structureProposal.parentName}” location to use:
                </p>
                <Form method="post" className="mt-3 flex flex-wrap gap-2">
                  <input
                    type="hidden"
                    name="instruction"
                    value={structureProposal.instruction}
                  />
                  <input
                    type="hidden"
                    name="workflow"
                    value="LOCATION_STRUCTURE"
                  />
                  <select
                    required
                    name="parentLocationId"
                    defaultValue=""
                    className="rounded border p-2"
                  >
                    <option value="" disabled>
                      Select a parent location
                    </option>
                    {structureProposal.parentCandidates.map((candidate) => (
                      <option key={candidate.id} value={candidate.id}>
                        {candidate.path}
                      </option>
                    ))}
                  </select>
                  <button className="rounded bg-red-700 px-3 py-2 text-white">
                    Use this parent
                  </button>
                </Form>
              </div>
            ) : structureProposal.unresolvedParent ? (
              <p className="mt-4 rounded bg-amber-50 p-4 text-sm">
                Parent location “
                {structureProposal.parentName ?? "(unspecified)"}” could not be
                resolved. Create it first or make the request more specific.
              </p>
            ) : (
              <>
                <p className="mt-4 text-sm">
                  <strong>Parent:</strong>{" "}
                  {structureProposal.parentLocationId
                    ? locations.find(
                        (location) =>
                          location.id === structureProposal.parentLocationId
                      )?.path ?? structureProposal.parentName
                    : "Top level"}
                </p>
                <p className="mt-1 text-sm text-gray-600">
                  {
                    structureProposal.nodes.filter(
                      (node) =>
                        /^section\b/i.test(node.name) ||
                        /\bsection$/i.test(node.name)
                    ).length
                  }{" "}
                  sections ·{" "}
                  {
                    structureProposal.nodes.filter((node) =>
                      /^shelf\b/i.test(node.name)
                    ).length
                  }{" "}
                  shelves ·{" "}
                  {
                    structureProposal.nodes.filter(
                      (node) => node.status === "CREATE"
                    ).length
                  }{" "}
                  locations to create ·{" "}
                  {
                    structureProposal.nodes.filter(
                      (node) => node.status === "EXISTS"
                    ).length
                  }{" "}
                  already exist
                </p>
                <ul className="mt-4 space-y-1 font-mono text-sm">
                  {structureProposal.nodes.map((node) => {
                    let depth = 1;
                    let parentTemp = node.parentTemporaryId;
                    while (parentTemp) {
                      depth++;
                      parentTemp =
                        structureProposal.nodes.find(
                          (candidate) => candidate.temporaryId === parentTemp
                        )?.parentTemporaryId ?? null;
                    }
                    return (
                      <li
                        key={node.temporaryId}
                        style={{ paddingLeft: `${depth * 1.25}rem` }}
                      >
                        {node.status === "EXISTS" ? "✓ " : "├── "}
                        {node.name}
                        {node.status === "EXISTS" ? " (exists)" : ""}
                      </li>
                    );
                  })}
                </ul>
                <div className="mt-5 flex flex-wrap gap-3">
                  <Form method="post">
                    <input
                      type="hidden"
                      name="intent"
                      value="create-structure"
                    />
                    <input
                      type="hidden"
                      name="proposal"
                      value={JSON.stringify(structureApplyPayload)}
                    />
                    <button
                      disabled={
                        !structureProposal.nodes.some(
                          (node) => node.status === "CREATE"
                        )
                      }
                      className="rounded-md bg-red-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                    >
                      Create all
                    </button>
                  </Form>
                  <button
                    type="button"
                    onClick={() =>
                      document
                        .getElementById("organization-instruction")
                        ?.focus()
                    }
                    className="rounded-md border px-4 py-2 text-sm"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => setDismissed(true)}
                    className="rounded-md border px-4 py-2 text-sm"
                  >
                    Cancel
                  </button>
                </div>
              </>
            )}
          </section>
        )}
        {proposal && !dismissed && (
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
