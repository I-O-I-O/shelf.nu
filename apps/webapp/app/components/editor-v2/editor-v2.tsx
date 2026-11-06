import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ChangeEvent, TextareaHTMLAttributes } from "react";
import "prosemirror-view/style/prosemirror.css";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { toggleMark, wrapIn } from "prosemirror-commands";
import { redo, undo } from "prosemirror-history";
import { wrapInList } from "prosemirror-schema-list";
import type { EditorState } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";

import { createEditorSchema } from "~/modules/editor-v2/markdoc-utils";
import { tw } from "~/utils/tw";

import { BubbleMenu } from "./components/bubble-menu";
import { LinkDialog, RawBlockDialog } from "./components/dialogs";
import { SlashCommandMenu } from "./components/slash-command-menu";
import { EditorToolbar } from "./components/toolbar";
import {
  createHorizontalRuleCommand,
  createSlashCommands,
  deleteHandbookHeadingCommand,
  insertHandbookHeadingCommand,
  insertImageBlock,
  moveHandbookHeadingCommand,
  renameHandbookHeadingCommand,
} from "./helpers";
import { useBubbleMenu } from "./hooks/use-bubble-menu";
import { useEditorCommands } from "./hooks/use-editor-commands";
import { useEditorView } from "./hooks/use-editor-view";
import { useLinkDialog } from "./hooks/use-link-dialog";
import { useRawBlockDialog } from "./hooks/use-raw-block-dialog";
import { useSlashCommands } from "./hooks/use-slash-commands";
import { useToolbarState } from "./hooks/use-toolbar-state";

interface EditorV2Props
  extends Omit<
    TextareaHTMLAttributes<HTMLTextAreaElement>,
    "defaultValue" | "onChange"
  > {
  label: string;
  name: string;
  defaultValue: string;
  onChange?: (value: string) => void;
  headingLevels?: number[];
  enableHandbookBlocks?: boolean;
  allowRawBlockEditing?: boolean;
  helpText?: string;
  onUploadImage?: (file: File) => Promise<{ src: string; alt?: string }>;
}

const HINT_TEXT = "Use / to access commands.";
const MAX_EDITOR_IMAGE_SIZE = 2 * 1024 * 1024;

export const EditorV2 = forwardRef<HTMLTextAreaElement, EditorV2Props>(
  function EditorV2(
    {
      defaultValue,
      label,
      name,
      placeholder,
      disabled,
      className,
      maxLength,
      headingLevels,
      enableHandbookBlocks = false,
      allowRawBlockEditing = true,
      helpText,
      onUploadImage,
      onBlur,
      onFocus,
      onChange,
      ...textareaProps
    },
    ref
  ) {
    const { autoFocus: shouldAutoFocus, ...restTextareaProps } =
      textareaProps as typeof textareaProps & { autoFocus?: boolean };

    const schema = useMemo(() => createEditorSchema(), []);
    const editorContainerRef = useRef<HTMLDivElement | null>(null);
    const hiddenTextareaRef = useRef<HTMLTextAreaElement | null>(null);
    const imageInputRef = useRef<HTMLInputElement | null>(null);
    const viewRef = useRef<EditorView | null>(null);
    const [toolsCollapsed, setToolsCollapsed] = useState(false);
    useEffect(() => {
      if (!enableHandbookBlocks) return;
      try {
        setToolsCollapsed(
          localStorage.getItem("handbook.editor.tools.collapsed") === "true"
        );
      } catch {
        // Editing remains available when browser storage is disabled.
      }
    }, [enableHandbookBlocks]);
    function toggleTools() {
      const next = !toolsCollapsed;
      setToolsCollapsed(next);
      try {
        localStorage.setItem("handbook.editor.tools.collapsed", String(next));
      } catch {
        // Keep the in-memory preference when storage is unavailable.
      }
    }
    const [imageBusy, setImageBusy] = useState(false);
    const [imageError, setImageError] = useState("");

    const requestImage = useCallback(() => {
      setImageError("");
      imageInputRef.current?.click();
    }, []);

    const commands = useMemo(
      () =>
        createSlashCommands(schema, {
          headingLevels,
          enableHandbookBlocks,
          onRequestImage: onUploadImage ? requestImage : undefined,
        }),
      [enableHandbookBlocks, headingLevels, onUploadImage, requestImage, schema]
    );

    // Initialize hooks (all hooks share the same viewRef)
    const { toolbarState, applyToolbarState } = useToolbarState();
    const { bubbleState, updateBubble } = useBubbleMenu();

    const {
      linkDialog,
      openLinkDialog,
      closeLinkDialog,
      applyLink,
      setLinkHref,
    } = useLinkDialog(schema, viewRef);

    const {
      rawBlockDialog,
      openRawBlockEditor,
      closeRawBlockEditor,
      applyRawBlockEdit,
      setRawBlockContent,
    } = useRawBlockDialog(viewRef);

    const {
      slashState,
      slashIndex,
      filteredCommands,
      updateSlash,
      applySlashCommand,
      handleSlashKeyDown,
      setSlashIndex,
      clearSlash,
    } = useSlashCommands(commands, viewRef);

    const { runCommand, handleParagraphChange } = useEditorCommands(
      schema,
      viewRef
    );

    const handleImageFile = async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.currentTarget.files?.[0];
      event.currentTarget.value = "";
      if (!file || !onUploadImage) return;
      if (file.size > MAX_EDITOR_IMAGE_SIZE) {
        setImageError("Images must be 2 MB or smaller.");
        return;
      }

      setImageBusy(true);
      setImageError("");
      try {
        const uploaded = await onUploadImage(file);
        const alt = uploaded.alt ?? file.name.replace(/\.[^.]+$/u, "").trim();
        if (
          !viewRef.current ||
          !insertImageBlock(viewRef.current, uploaded.src, alt)
        ) {
          throw new Error(
            "Place the cursor in the article before inserting an image."
          );
        }
      } catch (cause) {
        setImageError(
          cause instanceof Error
            ? cause.message
            : "The image could not be uploaded."
        );
      } finally {
        setImageBusy(false);
      }
    };

    // Extract onKeyDown from restTextareaProps if it exists
    const parentOnKeyDown = restTextareaProps.onKeyDown as
      | ((event: KeyboardEvent) => boolean)
      | undefined;

    const { markdocValue } = useEditorView(editorContainerRef, viewRef, {
      schema,
      defaultValue,
      disabled,
      placeholder,
      maxLength,
      allowRawBlockEditing,
      ariaLabel: label,
      enableImageBlockDrop: enableHandbookBlocks,
      shouldAutoFocus,
      onBlur: (event) => {
        // The slash menu is portaled to the body and positioned against the
        // viewport, so it outlives the editor's focus unless it is closed here.
        // Clicking the menu itself never reaches this: every control in the
        // editor chrome cancels mousedown, so the editor keeps focus.
        clearSlash();
        onBlur?.(event);
      },
      onFocus,
      onChange,
      onStateUpdate: (state: EditorState, view: EditorView) => {
        applyToolbarState(state);
        updateBubble(state, view);
        updateSlash(state, view);
      },
      onKeyDown: (event: KeyboardEvent) => {
        // First, let parent handle the event (e.g., Cmd+Enter to submit)
        if (parentOnKeyDown?.(event)) {
          return true;
        }
        // Then handle slash commands
        return handleSlashKeyDown(event);
      },
      openLinkDialog,
      openRawBlockEditor,
    });

    useImperativeHandle(ref, () => {
      const element = hiddenTextareaRef.current;
      if (!element) {
        return null as unknown as HTMLTextAreaElement;
      }
      return Object.assign(element, {
        focus: () => {
          if (viewRef.current) {
            viewRef.current.focus();
          } else {
            element.focus();
          }
        },
      });
    });

    useEffect(() => {
      if (hiddenTextareaRef.current) {
        hiddenTextareaRef.current.value = markdocValue;
      }
    }, [markdocValue]);

    useLayoutEffect(() => {
      if (shouldAutoFocus && viewRef.current) {
        viewRef.current.focus();
      }
    }, [shouldAutoFocus, viewRef]);

    return (
      <div className={tw("flex flex-col gap-2", className)}>
        <div
          className={tw(
            "isolate rounded-lg border border-gray-200 bg-white",
            enableHandbookBlocks
              ? tw(
                  "flex max-h-[75vh] flex-col xl:grid xl:max-h-none xl:items-start xl:gap-4",
                  toolsCollapsed
                    ? "xl:grid-cols-[minmax(0,1fr)_2.5rem]"
                    : "xl:grid-cols-[minmax(0,1fr)_13rem]"
                )
              : "overflow-hidden"
          )}
        >
          <div
            className={tw(
              "border-b border-gray-100 bg-white px-3 py-2",
              enableHandbookBlocks
                ? "sticky top-0 z-20 shrink-0 shadow-sm xl:top-24 xl:order-2 xl:max-h-[calc(100dvh-7rem)] xl:overflow-y-auto xl:border-b-0 xl:border-l xl:shadow-none"
                : ""
            )}
          >
            {enableHandbookBlocks ? (
              <div className="mb-1 hidden items-center justify-between gap-1 xl:flex">
                {!toolsCollapsed ? (
                  <span className="text-xs font-semibold text-gray-600">
                    Editor tools
                  </span>
                ) : null}
                <button
                  type="button"
                  aria-label={
                    toolsCollapsed ? "Show editor tools" : "Hide editor tools"
                  }
                  title={
                    toolsCollapsed ? "Show editor tools" : "Hide editor tools"
                  }
                  aria-expanded={!toolsCollapsed}
                  onClick={toggleTools}
                  className="inline-flex size-8 shrink-0 items-center justify-center rounded text-gray-600 hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-300"
                >
                  {toolsCollapsed ? (
                    <ChevronRight size={16} />
                  ) : (
                    <ChevronLeft size={16} />
                  )}
                </button>
              </div>
            ) : null}
            <div
              className={
                enableHandbookBlocks && toolsCollapsed ? "xl:hidden" : undefined
              }
            >
              <EditorToolbar
                state={toolbarState}
                onUndo={() => runCommand(undo)}
                onRedo={() => runCommand(redo)}
                onParagraphChange={handleParagraphChange}
                onBold={() => runCommand(toggleMark(schema.marks.strong))}
                onItalic={() => runCommand(toggleMark(schema.marks.em))}
                onInlineCode={() => runCommand(toggleMark(schema.marks.code))}
                onToggleLink={openLinkDialog}
                onBulletList={() =>
                  runCommand(wrapInList(schema.nodes.bullet_list))
                }
                onOrderedList={() =>
                  runCommand(wrapInList(schema.nodes.ordered_list))
                }
                onQuote={() => runCommand(wrapIn(schema.nodes.blockquote))}
                onDivider={
                  schema.nodes.horizontal_rule
                    ? () => runCommand(createHorizontalRuleCommand(schema))
                    : undefined
                }
                hasDivider={Boolean(schema.nodes.horizontal_rule)}
                headingLevels={headingLevels}
                enableHandbookBlocks={enableHandbookBlocks}
                codeActive={toolbarState.code}
                onRequestImage={onUploadImage ? requestImage : undefined}
                imageBusy={imageBusy}
                onAddSection={() =>
                  runCommand(insertHandbookHeadingCommand(schema, 2))
                }
                onAddSubsection={() =>
                  runCommand(insertHandbookHeadingCommand(schema, 3))
                }
                onRenameHeading={(title) =>
                  runCommand(renameHandbookHeadingCommand(schema, title))
                }
                onMoveHeadingUp={() =>
                  runCommand(moveHandbookHeadingCommand("up"))
                }
                onMoveHeadingDown={() =>
                  runCommand(moveHandbookHeadingCommand("down"))
                }
                onDeleteHeading={() =>
                  runCommand(deleteHandbookHeadingCommand())
                }
              />
            </div>
          </div>
          <div
            className={tw(
              "relative bg-gray-50 px-3 py-4 focus-within:ring-2 focus-within:ring-gray-300",
              enableHandbookBlocks
                ? "min-h-0 overflow-auto xl:order-1 xl:min-w-0 xl:overflow-visible"
                : ""
            )}
          >
            <div
              ref={editorContainerRef}
              className="min-h-[200px]"
              data-testid="editor-v2-content"
              role="document"
              tabIndex={-1}
              onMouseDown={(event) => {
                if (!(event.target instanceof HTMLElement)) {
                  return;
                }
                if (event.target.closest('[contenteditable="true"]')) {
                  return;
                }
                event.preventDefault();
                viewRef.current?.focus();
              }}
            />
            <BubbleMenu
              state={bubbleState}
              onBold={() => runCommand(toggleMark(schema.marks.strong))}
              onItalic={() => runCommand(toggleMark(schema.marks.em))}
              onInlineCode={() => runCommand(toggleMark(schema.marks.code))}
              onLink={openLinkDialog}
              boldActive={toolbarState.bold}
              italicActive={toolbarState.italic}
              codeActive={toolbarState.code}
              linkActive={toolbarState.link}
            />
            <SlashCommandMenu
              state={slashState}
              commands={filteredCommands}
              selectedIndex={slashIndex}
              onSelect={setSlashIndex}
              onRun={applySlashCommand}
            />
          </div>
        </div>
        <textarea
          ref={hiddenTextareaRef}
          name={name}
          value={markdocValue}
          readOnly
          hidden
          disabled={disabled}
          aria-hidden="true"
          data-testid="editor-v2-input"
          {...restTextareaProps}
        />
        {onUploadImage ? (
          <input
            ref={imageInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            aria-label="Choose an article image"
            onChange={handleImageFile}
            disabled={disabled || imageBusy}
          />
        ) : null}
        <div className="flex flex-col gap-1 text-xs text-gray-500">
          <span>
            {helpText ?? `${label} supports Markdown and Markdoc. ${HINT_TEXT}`}
          </span>
          {imageBusy ? <span role="status">Uploading image…</span> : null}
          {imageError ? <span role="alert">{imageError}</span> : null}
          {maxLength ? (
            <span
              className={
                markdocValue.length > maxLength ? "text-error-600" : undefined
              }
            >
              {markdocValue.length}/{maxLength}
            </span>
          ) : null}
        </div>
        <LinkDialog
          state={linkDialog}
          onClose={closeLinkDialog}
          onHrefChange={setLinkHref}
          onApply={applyLink}
        />
        {allowRawBlockEditing ? (
          <RawBlockDialog
            state={rawBlockDialog}
            onClose={closeRawBlockEditor}
            onChange={setRawBlockContent}
            onSave={applyRawBlockEdit}
          />
        ) : null}
      </div>
    );
  }
);
