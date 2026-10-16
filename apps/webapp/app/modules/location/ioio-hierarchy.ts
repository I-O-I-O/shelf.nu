export type IoioLocationCreationType =
  | "room"
  | "section"
  | "shelf"
  | "container";

export type IoioLocationParentContext = {
  name: string;
  parentId: string | null;
  grandparentId: string | null;
};

export type IoioLocationKind = "Rooms" | "Sections" | "Shelves" | "Containers";

export type IoioLocationNode = {
  id: string;
  name: string;
  parentId: string | null;
};

export type IoioAssetLocationAssignment = {
  assetId: string;
  locationId: string;
};

export type IoioLocationInventorySummary = {
  containerAssetCounts: Record<string, number>;
  rooms: Record<
    string,
    { sections: number; shelves: number; containers: number; assets: number }
  >;
  sections: Record<
    string,
    { shelves: number; containers: number; assets: number }
  >;
  unassignedOrIncompleteAssetCount: number;
};

export function inferIoioLocationKind(
  location: IoioLocationNode,
  locationsById: Map<string, IoioLocationNode>
): IoioLocationKind {
  if (!location.parentId) return "Rooms";

  const parent = locationsById.get(location.parentId);
  const depthOf = (node: IoioLocationNode) => {
    let depth = 0;
    let current: IoioLocationNode | undefined = node;
    const visited = new Set<string>();
    while (current?.parentId && !visited.has(current.id)) {
      visited.add(current.id);
      depth += 1;
      current = locationsById.get(current.parentId);
    }
    return depth;
  };
  const depth = depthOf(location);

  // Names help retain compatibility with legacy Room → Shelf records. New
  // IOIO hierarchy levels are otherwise determined by their parent depth so
  // arbitrary Staff-chosen names do not change their type after creation.
  if (depth === 1) {
    return /^(shelf|rack)\b/iu.test(location.name) ? "Shelves" : "Sections";
  }
  if (depth >= 3 || /^(container|box)\b/iu.test(location.name)) {
    return "Containers";
  }
  if (depth === 2 && /^(shelf|rack)\b/iu.test(parent?.name ?? "")) {
    return "Containers";
  }
  return "Shelves";
}

function isOperationalRoot(location: IoioLocationNode | undefined) {
  return !!location && /\b(broken|pick[\s-]?up|return)\b/iu.test(location.name);
}

/** Roll up active asset-location pairs for container and overview counts. */
export function summarizeIoioLocationInventory({
  locations,
  assignments,
  unassignedAssetCount,
}: {
  locations: IoioLocationNode[];
  assignments: IoioAssetLocationAssignment[];
  unassignedAssetCount: number;
}): IoioLocationInventorySummary {
  const locationsById = new Map(
    locations.map((location) => [location.id, location])
  );
  const childrenByParentId = new Map<string, IoioLocationNode[]>();
  for (const location of locations) {
    if (!location.parentId) continue;
    const children = childrenByParentId.get(location.parentId) ?? [];
    children.push(location);
    childrenByParentId.set(location.parentId, children);
  }

  const roomSummaries = new Map<
    string,
    {
      sections: Set<string>;
      shelves: Set<string>;
      containers: Set<string>;
      assets: Set<string>;
    }
  >();
  const sectionSummaries = new Map<
    string,
    {
      shelves: Set<string>;
      containers: Set<string>;
      assets: Set<string>;
    }
  >();

  for (const room of locations.filter((location) => !location.parentId)) {
    const summary = {
      sections: new Set<string>(),
      shelves: new Set<string>(),
      containers: new Set<string>(),
      assets: new Set<string>(),
    };
    const visited = new Set<string>();
    const queue = [...(childrenByParentId.get(room.id) ?? [])];
    while (queue.length) {
      const location = queue.shift()!;
      if (visited.has(location.id)) continue;
      visited.add(location.id);
      const kind = inferIoioLocationKind(location, locationsById);
      if (kind === "Sections") summary.sections.add(location.id);
      if (kind === "Shelves") summary.shelves.add(location.id);
      if (kind === "Containers") summary.containers.add(location.id);
      queue.push(...(childrenByParentId.get(location.id) ?? []));
    }
    roomSummaries.set(room.id, summary);
  }

  for (const section of locations.filter(
    (location) => inferIoioLocationKind(location, locationsById) === "Sections"
  )) {
    const summary = {
      shelves: new Set<string>(),
      containers: new Set<string>(),
      assets: new Set<string>(),
    };
    const visited = new Set<string>();
    const queue = [...(childrenByParentId.get(section.id) ?? [])];
    while (queue.length) {
      const location = queue.shift()!;
      if (visited.has(location.id)) continue;
      visited.add(location.id);
      const kind = inferIoioLocationKind(location, locationsById);
      if (kind === "Shelves") summary.shelves.add(location.id);
      if (kind === "Containers") summary.containers.add(location.id);
      queue.push(...(childrenByParentId.get(location.id) ?? []));
    }
    sectionSummaries.set(section.id, summary);
  }

  const containerAssets = new Map<string, Set<string>>();
  const incompleteAssetIds = new Set<string>();
  for (const assignment of assignments) {
    const location = locationsById.get(assignment.locationId);
    if (!location) continue;
    const path: IoioLocationNode[] = [];
    const visited = new Set<string>();
    let current: IoioLocationNode | undefined = location;
    while (current && !visited.has(current.id)) {
      visited.add(current.id);
      path.unshift(current);
      current = current.parentId
        ? locationsById.get(current.parentId)
        : undefined;
    }

    const room = path[0];
    const section = path.find(
      (node) =>
        node.parentId === room?.id &&
        inferIoioLocationKind(node, locationsById) === "Sections"
    );
    const kind = inferIoioLocationKind(location, locationsById);

    if (kind === "Containers") {
      const containerSet =
        containerAssets.get(location.id) ?? new Set<string>();
      containerSet.add(assignment.assetId);
      containerAssets.set(location.id, containerSet);
      if (room) roomSummaries.get(room.id)?.assets.add(assignment.assetId);
      if (section)
        sectionSummaries.get(section.id)?.assets.add(assignment.assetId);
    } else if (
      (kind === "Rooms" || kind === "Sections" || kind === "Shelves") &&
      !isOperationalRoot(room)
    ) {
      incompleteAssetIds.add(assignment.assetId);
    }
  }

  const assetsInAnyContainer = new Set(
    assignments
      .filter(({ locationId }) => {
        const location = locationsById.get(locationId);
        return (
          location &&
          inferIoioLocationKind(location, locationsById) === "Containers"
        );
      })
      .map(({ assetId }) => assetId)
  );
  for (const assetId of assetsInAnyContainer)
    incompleteAssetIds.delete(assetId);

  return {
    containerAssetCounts: Object.fromEntries(
      [...containerAssets].map(([locationId, assets]) => [
        locationId,
        assets.size,
      ])
    ),
    rooms: Object.fromEntries(
      [...roomSummaries].map(([locationId, summary]) => [
        locationId,
        {
          sections: summary.sections.size,
          shelves: summary.shelves.size,
          containers: summary.containers.size,
          assets: summary.assets.size,
        },
      ])
    ),
    sections: Object.fromEntries(
      [...sectionSummaries].map(([locationId, summary]) => [
        locationId,
        {
          shelves: summary.shelves.size,
          containers: summary.containers.size,
          assets: summary.assets.size,
        },
      ])
    ),
    unassignedOrIncompleteAssetCount:
      unassignedAssetCount + incompleteAssetIds.size,
  };
}

/** Keep the IOIO four-level placement rules shared by full and inline forms. */
export function getIoioLocationParentError({
  locationType,
  parentId,
  parent,
}: {
  locationType: IoioLocationCreationType;
  parentId: string | null;
  parent: IoioLocationParentContext | null;
}): string | null {
  if (locationType === "room") {
    return parentId ? "A room must be a top-level location." : null;
  }
  if (!parent) return "Choose a valid parent location.";

  const parentDepth = parent.parentId ? (parent.grandparentId ? 2 : 1) : 0;
  const valid =
    locationType === "section"
      ? parentDepth === 0
      : locationType === "shelf"
      ? parentDepth === 0 || parentDepth === 1
      : parentDepth === 2 ||
        (parentDepth === 1 && /^shelf\b/iu.test(parent.name));

  if (valid) return null;
  return locationType === "section"
    ? "A section must be placed inside a room."
    : locationType === "shelf"
    ? "A shelf must be placed inside a room or section."
    : "A container must be placed inside a shelf.";
}

export function findDuplicateIoioSiblingName(
  names: string[],
  candidateName: string
): string | undefined {
  const normalizedCandidate = candidateName.trim().toLocaleLowerCase();
  return names.find(
    (name) => name.trim().toLocaleLowerCase() === normalizedCandidate
  );
}
