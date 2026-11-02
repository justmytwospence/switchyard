import { createContext, useContext } from "react";

export type InspectorTab = "changes" | "files" | "task" | "extensions";

/** Cross-pane wiring inside one session view. */
export interface CodeViewContext {
  /** Mobile presentation (collapsed tool output, sheets). */
  mobile: boolean;
  /** Open a workspace file in the inspector Files tab (or mobile Details). */
  openFile?: (path: string) => void;
  /** Show an inspector tab (opening the drawer on compact). */
  openInspector?: (tab: InspectorTab) => void;
}

export const CodeContext = createContext<CodeViewContext>({ mobile: false });
export const useCodeContext = () => useContext(CodeContext);
