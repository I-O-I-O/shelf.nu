import { useEffect, useState, type ReactNode } from "react";

import {
  Bold,
  Code,
  ImagePlus,
  Italic,
  Link2,
  List,
  ListOrdered,
  Minus,
  Quote,
  RotateCcw,
  RotateCw,
  Type,
} from "lucide-react";

import { tw } from "~/utils/tw";

import type { ToolbarBlock, ToolbarState } from "../types";

interface ToolbarButtonProps {
  label: string;
  tooltip?: string;
  icon: ReactNode;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  isToggle?: boolean;
}

export function ToolbarButton({
  label,
  tooltip,
  icon,
  onClick,
  active = false,
  disabled,
  isToggle,
}: ToolbarButtonProps) {
  return (
    <button
      type="button"
      className={tw(
        "text-muted-foreground inline-flex size-9 items-center justify-center rounded border transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-200",
        active
          ? "text-foreground bg-muted"
          : "hover:text-foreground hover:bg-muted",
        disabled ? "cursor-not-allowed opacity-50" : ""
      )}
      aria-label={tooltip ?? label}
      title={tooltip ?? label}
      aria-pressed={isToggle ? active : undefined}
      data-active={active ? "true" : undefined}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => {
        if (disabled) return;
        onClick();
      }}
      disabled={disabled}
    >
      {icon}
      <span className="sr-only">{label}</span>
    </button>
  );
}

interface ParagraphSelectProps {
  value: ToolbarBlock;
  onChange: (value: ToolbarBlock) => void;
  headingLevels?: number[];
  enableHandbookBlocks?: boolean;
}

export function ParagraphSelect({
  value,
  onChange,
  headingLevels = [1, 2, 3, 4],
  enableHandbookBlocks = false,
}: ParagraphSelectProps) {
  const normalized = value === "raw_block" ? "paragraph" : value;
  const visibleHeadingLevels = [
    ...new Set([
      ...headingLevels,
      ...(value.startsWith("heading")
        ? [Number(value.slice("heading".length))]
        : []),
    ]),
  ].sort((a, b) => a - b);
  return (
    <label className="text-muted-foreground inline-flex h-9 items-center gap-2 rounded border bg-white px-2 text-sm">
      <Type size={18} strokeWidth={1.5} aria-hidden="true" />
      <span className="sr-only">Text style</span>
      <select
        className="text-foreground h-full appearance-none border-none bg-transparent pr-4 text-sm focus:outline-none focus-visible:ring-0"
        aria-label="Text style"
        title="Text style"
        value={normalized}
        onChange={(event) => onChange(event.target.value as ToolbarBlock)}
        disabled={value === "raw_block"}
      >
        <option value="paragraph">
          {enableHandbookBlocks ? "Text" : "Paragraph"}
        </option>
        {visibleHeadingLevels.map((level) => (
          <option key={level} value={`heading${level}`}>
            {enableHandbookBlocks && level === 2
              ? "Section"
              : enableHandbookBlocks && level === 3
              ? "Subsection"
              : `Heading ${level}`}
          </option>
        ))}
        <option value="bullet_list">Bullet list</option>
        <option value="ordered_list">Numbered list</option>
        <option value="blockquote">Quote</option>
      </select>
    </label>
  );
}

interface EditorToolbarProps {
  state: ToolbarState;
  onUndo: () => void;
  onRedo: () => void;
  onParagraphChange: (value: ToolbarBlock) => void;
  onBold: () => void;
  onItalic: () => void;
  onInlineCode: () => void;
  onToggleLink: () => void;
  onBulletList: () => void;
  onOrderedList: () => void;
  onQuote: () => void;
  onDivider?: () => void;
  hasDivider: boolean;
  headingLevels?: number[];
  codeActive?: boolean;
  onRequestImage?: () => void;
  imageBusy?: boolean;
  enableHandbookBlocks?: boolean;
  onAddSection?: () => void;
  onAddSubsection?: () => void;
  onRenameHeading?: (title: string) => void;
  onMoveHeadingUp?: () => void;
  onMoveHeadingDown?: () => void;
  onDeleteHeading?: () => void;
}

export function EditorToolbar({
  state,
  onUndo,
  onRedo,
  onParagraphChange,
  onBold,
  onItalic,
  onInlineCode,
  onToggleLink,
  onBulletList,
  onOrderedList,
  onQuote,
  onDivider,
  hasDivider,
  headingLevels,
  codeActive = false,
  onRequestImage,
  imageBusy = false,
  enableHandbookBlocks = false,
  onAddSection,
  onAddSubsection,
  onRenameHeading,
  onMoveHeadingUp,
  onMoveHeadingDown,
  onDeleteHeading,
}: EditorToolbarProps) {
  const [renamingHeading, setRenamingHeading] = useState(false);
  const [renameValue, setRenameValue] = useState(state.headingTitle ?? "");
  useEffect(() => {
    setRenamingHeading(false);
    setRenameValue(state.headingTitle ?? "");
  }, [state.headingLevel, state.headingTitle]);

  return (
    <div
      className="flex flex-wrap items-center gap-x-4 gap-y-2"
      role="toolbar"
      aria-label="Editor formatting toolbar"
    >
      <div className="flex items-center gap-2">
        <ToolbarButton
          label="Undo"
          tooltip="Undo (⌘Z)"
          icon={<RotateCcw size={18} strokeWidth={1.5} aria-hidden="true" />}
          onClick={onUndo}
          disabled={!state.canUndo}
        />
        <ToolbarButton
          label="Redo"
          tooltip="Redo (⌘⇧Z)"
          icon={<RotateCw size={18} strokeWidth={1.5} aria-hidden="true" />}
          onClick={onRedo}
          disabled={!state.canRedo}
        />
      </div>
      <ParagraphSelect
        value={state.block}
        onChange={onParagraphChange}
        headingLevels={headingLevels}
        enableHandbookBlocks={enableHandbookBlocks}
      />
      {enableHandbookBlocks && onAddSection && onAddSubsection ? (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={onAddSection}
            className="inline-flex h-9 items-center rounded-md border border-red-200 bg-red-50 px-3 text-sm font-semibold text-red-800 hover:bg-red-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300"
          >
            + Add section
          </button>
          <button
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={onAddSubsection}
            disabled={!state.canAddSubsection}
            title={
              state.canAddSubsection
                ? undefined
                : "Add a section before adding a subsection."
            }
            className="inline-flex h-9 items-center rounded-md border border-gray-300 bg-white px-3 text-sm font-semibold text-gray-700 hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-300 disabled:cursor-not-allowed disabled:opacity-50"
          >
            + Add subsection
          </button>
        </div>
      ) : null}
      <div className="flex items-center gap-2">
        <ToolbarButton
          label="Bold"
          tooltip="Bold (⌘B)"
          icon={<Bold size={18} strokeWidth={1.5} aria-hidden="true" />}
          onClick={onBold}
          active={state.bold}
          isToggle
        />
        <ToolbarButton
          label="Italic"
          tooltip="Italic (⌘I)"
          icon={<Italic size={18} strokeWidth={1.5} aria-hidden="true" />}
          onClick={onItalic}
          active={state.italic}
          isToggle
        />
        <ToolbarButton
          label="Inline code"
          tooltip="Inline code"
          icon={<Code size={18} strokeWidth={1.5} aria-hidden="true" />}
          onClick={onInlineCode}
          active={codeActive}
          isToggle
        />
        <ToolbarButton
          label="Link"
          tooltip="Link (⌘⇧K)"
          icon={<Link2 size={18} strokeWidth={1.5} aria-hidden="true" />}
          onClick={onToggleLink}
          active={state.link}
          isToggle
        />
      </div>
      <div className="flex items-center gap-2">
        <ToolbarButton
          label="Bulleted list"
          tooltip="Bulleted list (⌘⇧8)"
          icon={<List size={18} strokeWidth={1.5} aria-hidden="true" />}
          onClick={onBulletList}
          active={state.block === "bullet_list"}
          isToggle
        />
        <ToolbarButton
          label="Numbered list"
          tooltip="Numbered list (⌘⇧7)"
          icon={<ListOrdered size={18} strokeWidth={1.5} aria-hidden="true" />}
          onClick={onOrderedList}
          active={state.block === "ordered_list"}
          isToggle
        />
      </div>
      <div className="flex items-center gap-2">
        <ToolbarButton
          label="Quote"
          tooltip="Quote (⌘⇧9)"
          icon={<Quote size={18} strokeWidth={1.5} aria-hidden="true" />}
          onClick={onQuote}
          active={state.block === "blockquote"}
          isToggle
        />
        {hasDivider && onDivider ? (
          <ToolbarButton
            label="Divider"
            tooltip="Divider (---)"
            icon={<Minus size={18} strokeWidth={1.5} aria-hidden="true" />}
            onClick={onDivider}
          />
        ) : null}
        {onRequestImage ? (
          <ToolbarButton
            label="Insert image"
            tooltip="Insert image"
            icon={<ImagePlus size={18} strokeWidth={1.5} aria-hidden="true" />}
            onClick={onRequestImage}
            disabled={imageBusy}
          />
        ) : null}
      </div>
      {enableHandbookBlocks &&
      state.headingLevel &&
      onRenameHeading &&
      onMoveHeadingUp &&
      onMoveHeadingDown &&
      onDeleteHeading ? (
        <div
          className="flex flex-wrap items-center gap-2 border-l border-gray-200 pl-3"
          role="group"
          aria-label={`${
            state.headingLevel === 2 ? "Section" : "Subsection"
          } controls`}
        >
          <span className="max-w-48 truncate text-xs font-medium text-gray-500">
            {state.headingLevel === 2 ? "Section" : "Subsection"}:{" "}
            {state.headingTitle}
          </span>
          {renamingHeading ? (
            <>
              <input
                type="text"
                aria-label={`Rename ${
                  state.headingLevel === 2 ? "section" : "subsection"
                }`}
                value={renameValue}
                onChange={(event) => setRenameValue(event.currentTarget.value)}
                className="h-8 w-40 rounded border border-gray-300 px-2 text-sm focus:border-red-700 focus:outline-none focus:ring-2 focus:ring-red-100"
              />
              <button
                type="button"
                onClick={() => {
                  if (!renameValue.trim()) return;
                  onRenameHeading(renameValue);
                  setRenamingHeading(false);
                }}
                className="text-xs font-semibold text-red-800 hover:underline"
              >
                Save name
              </button>
              <button
                type="button"
                onClick={() => {
                  setRenameValue(state.headingTitle ?? "");
                  setRenamingHeading(false);
                }}
                className="text-xs font-semibold text-gray-600 hover:underline"
              >
                Cancel rename
              </button>
            </>
          ) : (
            <button
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => setRenamingHeading(true)}
              className="text-xs font-semibold text-red-800 hover:underline"
            >
              Rename
            </button>
          )}
          <button
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={onMoveHeadingUp}
            disabled={!state.canMoveHeadingUp}
            className="text-xs font-semibold text-gray-700 hover:underline disabled:cursor-not-allowed disabled:opacity-40"
          >
            Move up
          </button>
          <button
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={onMoveHeadingDown}
            disabled={!state.canMoveHeadingDown}
            className="text-xs font-semibold text-gray-700 hover:underline disabled:cursor-not-allowed disabled:opacity-40"
          >
            Move down
          </button>
          {state.headingLevel === 2 ? (
            <button
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={onAddSubsection}
              className="text-xs font-semibold text-gray-700 hover:underline"
            >
              Add subsection
            </button>
          ) : null}
          <button
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={onDeleteHeading}
            className="text-xs font-semibold text-red-700 hover:underline"
          >
            Delete {state.headingLevel === 2 ? "section" : "subsection"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
