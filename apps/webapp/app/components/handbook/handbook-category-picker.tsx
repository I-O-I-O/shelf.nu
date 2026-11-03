import type { ChangeEvent, KeyboardEvent } from "react";
import { useId, useMemo, useRef, useState } from "react";
import {
  Popover,
  PopoverContent,
  PopoverPortal,
  PopoverTrigger,
} from "@radix-ui/react-popover";
import { ChevronDownIcon, Search } from "lucide-react";
import { useAutoFocus } from "~/hooks/use-auto-focus";
import { tw } from "~/utils/tw";

type HandbookCategoryOption = { id: string; name: string };
type PickerMode = "staff" | "student";

function normalizeName(value: string) {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
}

function cleanName(value: string) {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ");
}

export function HandbookCategoryPicker({
  categories,
  value,
  proposedName = "",
  mode = "staff",
  creating = false,
  onChange,
  onCreateCategory,
}: {
  categories: HandbookCategoryOption[];
  value: string;
  proposedName?: string;
  mode?: PickerMode;
  creating?: boolean;
  onChange: (categoryId: string, proposedCategoryName: string) => void;
  onCreateCategory?: (name: string) => void;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const baseId = useId();
  const listboxId = `${baseId}-listbox`;
  const getOptionId = (index: number) => `${baseId}-option-${index}`;
  const searchInputRef = useAutoFocus<HTMLInputElement>({ when: isOpen });
  const selectedCategory = categories.find((category) => category.id === value);
  const cleanedQuery = cleanName(searchQuery);
  const normalizedQuery = normalizeName(searchQuery);

  const filteredCategories = useMemo(() => {
    if (!normalizedQuery) return categories;
    return categories.filter((category) =>
      normalizeName(category.name).includes(normalizedQuery)
    );
  }, [categories, normalizedQuery]);
  const hasExactMatch = Boolean(
    normalizedQuery &&
      categories.some(
        (category) => normalizeName(category.name) === normalizedQuery
      )
  );
  const canOfferAction =
    cleanedQuery.length > 0 &&
    cleanedQuery.length <= 80 &&
    !hasExactMatch &&
    (mode === "student" || Boolean(onCreateCategory));
  const actionIndex = filteredCategories.length;
  const optionCount = filteredCategories.length + (canOfferAction ? 1 : 0);

  function handleSearch(event: ChangeEvent<HTMLInputElement>) {
    setSearchQuery(event.target.value);
    setSelectedIndex(0);
  }

  function closePicker() {
    setSearchQuery("");
    setSelectedIndex(0);
    setIsOpen(false);
  }

  function handleSelect(category: HandbookCategoryOption) {
    onChange(category.id, "");
    closePicker();
  }

  function handleAction() {
    if (!canOfferAction) return;
    if (mode === "staff") onCreateCategory?.(cleanedQuery);
    else onChange("", cleanedQuery);
    closePicker();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setSelectedIndex((index) =>
          optionCount ? Math.min(index + 1, optionCount - 1) : 0
        );
        break;
      case "ArrowUp":
        event.preventDefault();
        setSelectedIndex((index) => Math.max(index - 1, 0));
        break;
      case "Enter":
        if (selectedIndex < filteredCategories.length) {
          const category = filteredCategories[selectedIndex];
          if (category) {
            event.preventDefault();
            handleSelect(category);
          }
        } else if (canOfferAction && selectedIndex === actionIndex) {
          event.preventDefault();
          handleAction();
        }
        break;
    }
  }

  const triggerText = selectedCategory?.name
    ? selectedCategory.name
    : proposedName
    ? `Proposed: ${proposedName}`
    : "Search or select a Handbook category...";

  return (
    <>
      <Popover
        open={isOpen}
        onOpenChange={(open) => {
          setIsOpen(open);
          if (open) {
            setSearchQuery("");
            setSelectedIndex(0);
          }
        }}
      >
        <PopoverTrigger asChild>
          <button
            ref={triggerRef}
            type="button"
            role="combobox"
            aria-label="Category"
            aria-haspopup="listbox"
            aria-expanded={isOpen}
            aria-controls={listboxId}
            aria-required="true"
            className="mt-1 flex h-10 w-full items-center justify-between gap-2 rounded-lg border border-gray-300 bg-white px-3 text-left font-normal text-gray-800 focus:border-red-700 focus:outline-none focus:ring-2 focus:ring-red-100"
          >
            <span
              className={tw(
                !selectedCategory && !proposedName && "text-gray-500"
              )}
            >
              {triggerText}
            </span>
            <ChevronDownIcon aria-hidden="true" className="size-4 shrink-0" />
          </button>
        </PopoverTrigger>
        <input type="hidden" name="handbookCategoryId" value={value} />
        <input type="hidden" name="proposedCategoryName" value={proposedName} />
        <PopoverPortal>
          <PopoverContent
            align="start"
            sideOffset={4}
            className="z-[999999] rounded-lg border border-gray-200 bg-white shadow-lg"
            style={{ width: triggerRef.current?.clientWidth }}
          >
            <div className="flex items-center border-b border-gray-200 px-3">
              <Search
                aria-hidden="true"
                className="size-4 shrink-0 text-gray-400"
              />
              <input
                ref={searchInputRef}
                role="combobox"
                aria-label="Search Handbook categories"
                aria-expanded={isOpen}
                aria-controls={listboxId}
                aria-activedescendant={
                  optionCount ? getOptionId(selectedIndex) : undefined
                }
                aria-autocomplete="list"
                placeholder="Search Handbook categories..."
                className="h-10 w-full border-0 px-2 text-sm outline-none focus:ring-0"
                value={searchQuery}
                onChange={handleSearch}
                onKeyDown={handleKeyDown}
              />
            </div>
            <div
              id={listboxId}
              role="listbox"
              aria-label="Handbook category options"
              className="max-h-60 overflow-y-auto p-1"
            >
              {filteredCategories.map((category, index) => (
                <div
                  key={category.id}
                  id={getOptionId(index)}
                  role="option"
                  aria-selected={category.id === value}
                  tabIndex={-1}
                  className={tw(
                    "cursor-pointer rounded-md px-3 py-2 text-sm text-gray-700 hover:bg-gray-50",
                    selectedIndex === index && "bg-gray-50",
                    category.id === value && "font-semibold text-gray-950"
                  )}
                  onClick={() => handleSelect(category)}
                >
                  {category.name}
                </div>
              ))}
              {canOfferAction ? (
                <div
                  id={getOptionId(actionIndex)}
                  role="option"
                  aria-selected={selectedIndex === actionIndex}
                  tabIndex={-1}
                  aria-disabled={creating}
                  className={tw(
                    "cursor-pointer rounded-md px-3 py-2 text-sm font-semibold text-red-800 hover:bg-red-50",
                    selectedIndex === actionIndex && "bg-red-50",
                    creating && "cursor-wait opacity-60"
                  )}
                  onClick={() => !creating && handleAction()}
                >
                  {creating
                    ? "Creating category…"
                    : `${
                        mode === "staff" ? "Create" : "Propose"
                      } “${cleanedQuery}”`}
                </div>
              ) : null}
              {!filteredCategories.length && !canOfferAction ? (
                <p role="status" className="px-3 py-2 text-sm text-gray-500">
                  {categories.length
                    ? "No matching Handbook categories. Enter a new name to continue."
                    : "No Handbook categories yet. Enter a name to create or propose one."}
                </p>
              ) : null}
            </div>
          </PopoverContent>
        </PopoverPortal>
      </Popover>
    </>
  );
}
