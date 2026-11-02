import type { InteractionResponse } from "@switchyard/protocol";
import { createContext, useContext } from "react";

/** Handlers available to a rendered UINode tree. */
export interface IntentHandlers {
  /** Interaction context: form submit, confirm, cancel and action buttons respond here. */
  onRespond?: (response: InteractionResponse) => void;
  /** Panel/tool-card context: `actions` buttons call this when there is no `onRespond`. */
  onAction?: (actionId: string) => void;
  /** File refs call this when provided (e.g. open in the inspector); otherwise render as text. */
  onOpenFile?: (path: string) => void;
  /** A response is in flight: inputs stay visible, buttons show busy. */
  busy?: boolean;
  /** Read-only (already answered, expired, read-only session). */
  disabled?: boolean;
}

export const IntentContext = createContext<IntentHandlers>({});
export const useIntent = () => useContext(IntentContext);
