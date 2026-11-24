import { useCallback, useState } from "react";
import { redoDepth, undoDepth } from "prosemirror-history";
import type { EditorState } from "prosemirror-state";

import {
  canAddHandbookSubsection,
  getBlockFromState,
  getHandbookHeadingContext,
  markIsActive,
} from "../helpers";
import type { ToolbarState } from "../types";

const INITIAL_TOOLBAR_STATE: ToolbarState = {
  block: "paragraph",
  bold: false,
  italic: false,
  code: false,
  link: false,
  canUndo: false,
  canRedo: false,
};

export function useToolbarState() {
  const [toolbarState, setToolbarState] = useState<ToolbarState>(
    INITIAL_TOOLBAR_STATE
  );

  const applyToolbarState = useCallback((state: EditorState) => {
    const block = getBlockFromState(state);
    const bold = markIsActive(state, "strong");
    const italic = markIsActive(state, "em");
    const code = markIsActive(state, "code");
    const link = markIsActive(state, "link");
    const heading = getHandbookHeadingContext(state);
    const next: ToolbarState = {
      block,
      bold,
      italic,
      code,
      link,
      canUndo: undoDepth(state) > 0,
      canRedo: redoDepth(state) > 0,
      ...(heading
        ? {
            headingLevel: heading.level,
            headingTitle: heading.title,
            canMoveHeadingUp: heading.canMoveUp,
            canMoveHeadingDown: heading.canMoveDown,
          }
        : {}),
      canAddSubsection: canAddHandbookSubsection(state),
    };
    setToolbarState(next);
  }, []);

  return {
    toolbarState,
    applyToolbarState,
  };
}
