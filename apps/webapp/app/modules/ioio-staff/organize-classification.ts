export function classifyOrganizationRequest(
  instruction: string
):
  | "LOCATION_STRUCTURE"
  | "INVENTORY_REORGANIZATION"
  | "MIXED_OR_ADVISORY"
  | "UNSUPPORTED" {
  const text = instruction.toLowerCase();
  const structureNoun =
    /\b(room|section|shelves?|drawers?|containers?|cabinets?|storage area|locations?)\b/.test(
      text
    );
  const structureVerb =
    /\b(create|add|make|build|ensure|remove|delete|clear|rename|merge|split|restructure)\b/.test(
      text
    );
  const inventoryNoun =
    /\b(items?|assets?|inventory|products?|electronics|boards?|sensors?|cables?)\b/.test(
      text
    ) || /\b(this|that|these|those|selected)\b/.test(text);
  const inventoryVerb =
    /\b(move|relocate|reorganize|place|stored|placement|wrong location|better places?|better locations?|alternative locations?|where else|where should|overflow(?:ing)?|overcrowded|crowded|spread (?:these|them|the items)?\s*out|need more space)\b/.test(
      text
    );
  const explicitStructureNoun =
    /\b(room|section|shelves?|drawers?|containers?|cabinets?|storage area)\b/.test(
      text
    );
  const destructiveStructureVerb =
    /\b(remove|delete|clear|rename|merge|split|create|add|make|build|ensure)\b/.test(
      text
    );
  const mixedIntent =
    /\b(layout|structure)\b/.test(text) && inventoryNoun && inventoryVerb;
  if (mixedIntent) return "MIXED_OR_ADVISORY";
  if (inventoryNoun && inventoryVerb && !destructiveStructureVerb)
    return "INVENTORY_REORGANIZATION";
  if (inventoryNoun && inventoryVerb && !explicitStructureNoun)
    return "INVENTORY_REORGANIZATION";
  if (structureNoun && structureVerb) {
    return inventoryNoun && inventoryVerb
      ? "MIXED_OR_ADVISORY"
      : "LOCATION_STRUCTURE";
  }
  if (inventoryNoun && inventoryVerb) return "INVENTORY_REORGANIZATION";
  if (structureNoun) return "LOCATION_STRUCTURE";
  return "UNSUPPORTED";
}
