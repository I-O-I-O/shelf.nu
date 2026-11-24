export const BUILT_IN_LAB_INFO_SECTIONS = [
  { key: "about", title: "About", field: "aboutText" },
  {
    key: "borrowing",
    title: "How borrowing works",
    field: "borrowingText",
  },
  { key: "rules", title: "Rules", field: "rulesText" },
  { key: "returns", title: "Returns", field: "returnText" },
  { key: "help", title: "Help", field: "helpText" },
  { key: "opening-hours", title: "Opening hours", kind: "opening-hours" },
  { key: "lab-tas", title: "Lab TAs", kind: "lab-tas" },
] as const;

export type BuiltInLabInfoSection = (typeof BUILT_IN_LAB_INFO_SECTIONS)[number];
export type BuiltInLabInfoSectionKey = BuiltInLabInfoSection["key"];

export type LabInfoSectionImage = {
  id: string;
  url: string;
  position: number;
  caption: string | null;
  altText: string | null;
};

export type LabInfoSectionView = {
  key: string;
  title: string;
  position: number;
  isCustom: boolean;
  text: string;
  field?:
    | "aboutText"
    | "borrowingText"
    | "rulesText"
    | "returnText"
    | "helpText";
  kind?: "opening-hours" | "lab-tas";
  images: LabInfoSectionImage[];
};

export function orderLabInfoSections<
  T extends { key: string; position: number },
>(sections: T[]) {
  return [...sections].sort((a, b) => {
    if (a.key === "about") return b.key === "about" ? 0 : -1;
    if (b.key === "about") return 1;
    return a.position - b.position || a.key.localeCompare(b.key);
  });
}

export function isBuiltInLabInfoSectionKey(
  key: string
): key is BuiltInLabInfoSectionKey {
  return BUILT_IN_LAB_INFO_SECTIONS.some((section) => section.key === key);
}
