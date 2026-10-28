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
  deleteApprovedStructureContainers,
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
    header: { title: "Organize" },
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
      const submittedProposal: unknown = JSON.parse(rawProposal);
      if (
        typeof submittedProposal !== "object" ||
        submittedProposal === null ||
        Array.isArray(submittedProposal)
      )
        throw new Error("Reload the structure proposal and review it again.");
      const result = await createLocationStructure({
        organizationId,
        userId,
        proposalInput: {
          ...submittedProposal,
          mode: "LOCATION_STRUCTURE",
        },
      });
      return payload({ kind: "structure-created" as const, result });
    }
    if (intent === "delete-structure-containers") {
      await requirePermission({
        userId,
        request,
        entity: PermissionEntity.location,
        action: PermissionAction.delete,
      });
      const rawIds = form.get("targets");
      if (typeof rawIds !== "string" || rawIds.length > 20_000)
        throw new Error("Reload the deletion proposal and review it again.");
      const targets: unknown = JSON.parse(rawIds);
      const results = await deleteApprovedStructureContainers({
        organizationId,
        targets,
      });
      return payload({ kind: "structure-deleted" as const, results });
    }
    const instruction = String(form.get("instruction") ?? "").trim();
    if (!instruction || instruction.length > 2_000)
      throw new Error(
        "Describe what you want to organize (up to 2,000 characters)."
      );
    const classification = classifyOrganizationRequest(instruction);
    const asksForAnalysis =
      /^\s*(what|which|where|how|show|list|compare|summarize|tell)\b/i.test(
        instruction
      );
    if (classification !== "INVENTORY_REORGANIZATION" || asksForAnalysis) {
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
      })),
    });
  } catch (cause) {
    const reason = makeShelfError(cause);
    return data(error(reason), { status: reason.status });
  }
}

export const meta = () => [{ title: appendToMetaTitle("Organize") }];
export const handle = {
  breadcrumb: () => <Link to="/staff/organize">Organize</Link>,
};

export default function StaffOrganizePage() {
  const { categories, locations } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const [reviewState, setReviewState] = useState<
    Record<string, "kept" | "ignored">
  >({});
  const [dismissed, setDismissed] = useState(false);
  const [structureNodeDecisions, setStructureNodeDecisions] = useState<
    Record<string, { action: "CREATE" } | { action: "EXISTS"; id: string }>
  >({});
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
  const structureDeleted =
    result && "kind" in result && result.kind === "structure-deleted"
      ? result.results
      : null;
  const structureApplyPayload = structureProposal
    ? {
        mode: "LOCATION_STRUCTURE",
        instruction: structureProposal.instruction,
        parentLocationId: structureProposal.parentLocationId,
        nodes: structureProposal.nodes.map((node) => {
          const decision = structureNodeDecisions[node.temporaryId];
          return {
            temporaryId: node.temporaryId,
            parentLocationId: node.parentLocationId,
            parentTemporaryId: node.parentTemporaryId,
            name: node.name,
            description: node.description,
            status:
              node.status === "POSSIBLE_DUPLICATE"
                ? decision?.action ?? "REVIEW"
                : node.status,
            existingLocationId:
              decision?.action === "EXISTS"
                ? decision.id
                : node.existingLocationId,
            confirmedPossibleDuplicate:
              node.status === "POSSIBLE_DUPLICATE" &&
              decision?.action === "CREATE",
          };
        }),
      }
    : null;
  return (
    <div>
      <Header hideQuickFind />
      <main className="mx-auto max-w-6xl px-4 py-6">
        <h1 className="text-2xl font-semibold">Organize</h1>
        <p className="mt-2 text-sm text-gray-600">
          Describe what you want to change in the lab. You can create storage
          areas, reorganize shelves, move inventory, or ask for placement
          suggestions.
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
              placeholder="Describe what you want to organize, create, move, or improve..."
              className="mt-2 block w-full rounded-md border border-gray-300 p-3 font-normal"
            />
          </label>
          <ul className="space-y-1 text-sm text-gray-500" aria-label="Examples">
            <li>
              “Create Section A and B in the Storage Room with 7 shelves each.”
            </li>
            <li>“Add 3 containers to Shelf A1.”</li>
            <li>“Find better locations for items in General Electronics.”</li>
            <li>
              “Review our development boards and suggest where they should go.”
            </li>
          </ul>
          <button className="rounded-md bg-red-700 px-4 py-2 text-sm font-semibold text-white">
            Analyze
          </button>
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
              {structureCreated.failedCount} failed ·{" "}
              {structureCreated.blockedCount} blocked by a failed parent
            </p>
            <ul className="mt-4 space-y-2 text-sm">
              {structureCreated.results.map((item, index) => (
                <li
                  key={`${item.name}-${index}`}
                  className={
                    item.status === "CREATED" || item.status === "EXISTS"
                      ? ""
                      : "text-red-700"
                  }
                >
                  {item.status}: {item.path}
                  {item.error ? ` — ${item.error}` : ""}
                </li>
              ))}
            </ul>
          </section>
        )}
        {structureDeleted && (
          <section
            className="mt-8 rounded-xl border p-5"
            aria-label="Location deletion results"
          >
            <h2 className="text-xl font-semibold">Storage structure results</h2>
            <ul className="mt-3 space-y-1 text-sm">
              {structureDeleted.map((item) => (
                <li key={item.id}>
                  {item.status}
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
                {structureProposal.analysis
                  ? "Location analysis"
                  : "Storage structure proposal"}
              </h2>
              <span className="rounded-full bg-amber-50 px-3 py-1 text-sm font-medium text-amber-800">
                Preview only · no changes made
              </span>
            </div>
            {structureProposal.helperUnavailable && (
              <p className="mt-4 text-sm text-red-700">
                The task planner could not complete. Check helper availability
                and try again.
              </p>
            )}
            {structureProposal.planError && (
              <p role="status" className="mt-4 rounded bg-amber-50 p-3 text-sm">
                {structureProposal.planError}
              </p>
            )}
            {structureProposal.unresolvedReferences?.map((reference) => (
              <div
                key={reference.stepId}
                className="mt-3 rounded border border-amber-300 p-3 text-sm"
              >
                <p>
                  Review location: {reference.ref.name}.{" "}
                  {reference.candidateIds.length
                    ? "Choose a matching location within the requested scope."
                    : "No location matched within the requested scope. Update the request to continue."}
                </p>
                {reference.candidateIds.length > 0 && (
                  <Form method="post" className="mt-2 flex gap-2">
                    <input
                      type="hidden"
                      name="instruction"
                      value={structureProposal.instruction}
                    />
                    <select
                      required
                      name="parentLocationId"
                      defaultValue=""
                      className="rounded border p-2"
                    >
                      <option value="" disabled>
                        Select a location
                      </option>
                      {reference.candidateIds.map((id) => (
                        <option key={id} value={id}>
                          {locations.find((location) => location.id === id)
                            ?.path ?? "Location unavailable"}
                        </option>
                      ))}
                    </select>
                    <button className="rounded bg-red-700 px-3 py-2 text-white">
                      Use this location
                    </button>
                  </Form>
                )}
              </div>
            ))}
            {structureProposal.planError ? null : structureProposal.unresolvedParent &&
              structureProposal.parentCandidates.length > 0 ? (
              <div className="mt-4 rounded bg-amber-50 p-4">
                <p className="font-medium">
                  {structureProposal.parentResolution === "AMBIGUOUS_MATCH"
                    ? `Which location did you mean by “${structureProposal.parentName}”?`
                    : structureProposal.parentName
                    ? `“${structureProposal.parentName}” does not exist yet. Where should we create it?`
                    : "Choose the parent location for this structure:"}
                </p>
                <Form method="post" className="mt-3 flex flex-wrap gap-2">
                  <input
                    type="hidden"
                    name="instruction"
                    value={structureProposal.instruction}
                  />
                  <select
                    required
                    name="parentLocationId"
                    defaultValue=""
                    className="rounded border p-2"
                  >
                    <option value="" disabled>
                      Select a location
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
                No existing parent locations are available. Add a location in
                Shelf, then analyze this request again.
              </p>
            ) : structureProposal.analysis ? (
              <div className="mt-4 text-sm">
                <p>
                  Read-only location hierarchy and asset-placement counts from
                  current Shelf data. No movement or category recommendations
                  were generated.
                </p>
                <p className="mt-2">
                  {structureProposal.analysis.locationsConsidered} locations in
                  scope
                  {structureProposal.analysis.truncated
                    ? " · first 100 shown"
                    : ""}
                  .
                </p>
                <ul className="mt-3 space-y-2">
                  {structureProposal.analysis.rows.map((row) => (
                    <li key={row.id}>
                      {row.path} —{" "}
                      {row.placements === null
                        ? "Inventory counts not requested"
                        : `${row.placements} asset placements · ${row.units} units`}
                    </li>
                  ))}
                </ul>
              </div>
            ) : structureProposal.deletionReview ? (
              <>
                <p className="mt-4 text-sm">
                  <strong>Parent:</strong>{" "}
                  {structureProposal.deletionReview.parentPath ??
                    "Resolved from current Shelf hierarchy"}
                </p>
                <p className="mt-2 text-sm text-gray-600">
                  Preview only ·{" "}
                  {structureProposal.deletionReview.totalSelected} empty
                  locations selected. Occupied locations are blocked. For
                  “half”, Shelf selects floor(N/2), preferring empty locations
                  and then natural name order.
                </p>
                {structureProposal.deletionReview.sections.map((section) => (
                  <div
                    key={section.sectionName}
                    className="mt-4 rounded border p-3"
                  >
                    <h3 className="font-semibold">
                      {section.sectionName} · {section.total}{" "}
                      {section.requestedRole === "DRAWER"
                        ? "drawers"
                        : "containers"}{" "}
                      found · {section.selected.length} selected ·{" "}
                      {section.blocked.length} blocked
                    </h3>
                    <p className="mt-2 text-sm">
                      Requested: Remove{" "}
                      {section.requestedQuantity === "ALL"
                        ? "all"
                        : "mode" in section.requestedQuantity
                        ? section.requestedQuantity.count
                        : `${section.requestedQuantity.numerator}/${section.requestedQuantity.denominator}`}{" "}
                      {section.requestedRole === "DRAWER"
                        ? "drawers"
                        : "containers"}
                      . Eligible empty: {section.total - section.blocked.length}
                      .
                    </p>
                    {section.total === 0 && (
                      <p className="mt-2 text-sm">Nothing to remove.</p>
                    )}
                    {section.selected.length > 0 && (
                      <ul className="mt-2 text-sm">
                        {section.selected.map((item) => (
                          <li key={item.id}>
                            {item.path} — {item.reason}
                          </li>
                        ))}
                      </ul>
                    )}
                    {section.blocked.length > 0 && (
                      <ul className="mt-2 text-sm text-amber-800">
                        {section.blocked.map((item) => (
                          <li key={item.id}>
                            {item.path} — {item.reason}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ))}
                <Form method="post" className="mt-5">
                  <input
                    type="hidden"
                    name="intent"
                    value="delete-structure-containers"
                  />
                  <input
                    type="hidden"
                    name="targets"
                    value={JSON.stringify(
                      structureProposal.deletionReview.sections.flatMap(
                        (section) =>
                          section.selected.map(
                            ({
                              id,
                              requestedRole,
                              sectionId,
                              shelfId,
                              path,
                            }) => ({
                              id,
                              requestedRole,
                              sectionId,
                              shelfId,
                              path,
                            })
                          )
                      )
                    )}
                  />
                  <button
                    disabled={!structureProposal.deletionReview.totalSelected}
                    className="rounded bg-red-700 px-4 py-2 text-sm font-semibold text-white"
                  >
                    Apply approved changes
                  </button>
                </Form>
              </>
            ) : (
              <>
                {structureProposal.createMissingParent && (
                  <p className="mt-4 rounded bg-amber-50 p-3 text-sm">
                    {structureProposal.parentName} does not currently exist.
                    This proposal will create it under{" "}
                    {structureProposal.parentCandidates[0]?.path ??
                      "the selected location"}
                    .
                  </p>
                )}
                <p className="mt-4 text-sm">
                  <strong>Parent:</strong>{" "}
                  {structureProposal.parentLocationId
                    ? locations.find(
                        (location) =>
                          location.id === structureProposal.parentLocationId
                      )?.path ?? structureProposal.parentName
                    : "Top level"}
                </p>
                {structureProposal.bulkSummary ? (
                  <div className="mt-1 text-sm text-gray-600">
                    <p>
                      Sections scanned:{" "}
                      {structureProposal.bulkSummary.sectionsScanned} · Shelves
                      scanned: {structureProposal.bulkSummary.shelvesScanned} ·
                      New shelves: {structureProposal.bulkSummary.newShelves} ·
                      Existing target{" "}
                      {structureProposal.bulkSummary.targetLabel} reused:{" "}
                      {structureProposal.bulkSummary.existingTargetCount} · New{" "}
                      {structureProposal.bulkSummary.targetLabel} to create:{" "}
                      {structureProposal.bulkSummary.newTargetCount} · Sections
                      with no shelves:{" "}
                      {structureProposal.bulkSummary.emptySections.length}
                    </p>
                    <p className="mt-1">
                      New targets under existing shelves:{" "}
                      {
                        structureProposal.bulkSummary
                          .newTargetsUnderExistingShelves
                      }{" "}
                      · Total new locations:{" "}
                      {structureProposal.bulkSummary.totalNewLocations}
                    </p>
                    {structureProposal.bulkSummary.emptySections.length > 0 && (
                      <p className="mt-1">
                        No shelves found — nothing to create:{" "}
                        {structureProposal.bulkSummary.emptySections.join(", ")}
                      </p>
                    )}
                    {structureProposal.bulkSummary.alreadyCompleteShelves
                      .length > 0 && (
                      <p className="mt-1">
                        Already complete:{" "}
                        {structureProposal.bulkSummary.alreadyCompleteShelves.join(
                          ", "
                        )}
                      </p>
                    )}
                  </div>
                ) : (
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
                )}
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
                        {node.reviewNote && (
                          <span className="ml-2 font-sans text-gray-600">
                            — {node.reviewNote}
                          </span>
                        )}
                        {node.status === "POSSIBLE_DUPLICATE" && (
                          <div className="mt-2 rounded border border-amber-300 bg-amber-50 p-3 font-sans">
                            <p className="font-medium">
                              Possible existing match:{" "}
                              {node.possibleExistingMatches
                                ?.map((match) => match.name)
                                .join(", ")}
                            </p>
                            <div className="mt-2 flex flex-wrap gap-2">
                              {node.possibleExistingMatches?.map((match) => {
                                const decision =
                                  structureNodeDecisions[node.temporaryId];
                                return (
                                  <button
                                    key={match.id}
                                    type="button"
                                    aria-pressed={
                                      decision?.action === "EXISTS" &&
                                      decision.id === match.id
                                    }
                                    onClick={() =>
                                      setStructureNodeDecisions((current) => ({
                                        ...current,
                                        [node.temporaryId]: {
                                          action: "EXISTS",
                                          id: match.id,
                                        },
                                      }))
                                    }
                                    className="rounded border px-3 py-1"
                                  >
                                    Use existing: {match.path}
                                  </button>
                                );
                              })}
                              {node.canCreateDespitePossibleMatch && (
                                <button
                                  type="button"
                                  aria-pressed={
                                    structureNodeDecisions[node.temporaryId]
                                      ?.action === "CREATE"
                                  }
                                  onClick={() =>
                                    setStructureNodeDecisions((current) => ({
                                      ...current,
                                      [node.temporaryId]: { action: "CREATE" },
                                    }))
                                  }
                                  className="rounded border px-3 py-1"
                                >
                                  Create {node.name}
                                </button>
                              )}
                            </div>
                          </div>
                        )}
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
                        structureProposal.unresolvedParent ||
                        structureProposal.nodes.some(
                          (node) =>
                            node.status === "POSSIBLE_DUPLICATE" &&
                            !structureNodeDecisions[node.temporaryId]
                        ) ||
                        !structureProposal.nodes.some(
                          (node) =>
                            node.status === "CREATE" ||
                            (node.status === "POSSIBLE_DUPLICATE" &&
                              structureNodeDecisions[node.temporaryId]
                                ?.action === "CREATE")
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
            <p className="mt-1 text-sm text-gray-600">
              Analyzed:{" "}
              {proposal.diagnostics.analysisScope ??
                "inventory items in the requested scope"}
              .
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
