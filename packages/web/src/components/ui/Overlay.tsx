import { X } from "lucide-react";
import { type ReactNode, type RefObject, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { cn } from "../../lib/cn";
import { errorMessage } from "../../sync/api";
import { Button } from "./Button";
import { IconButton } from "./IconButton";
import { ErrorState, InlineError } from "./states";
import { useFocusTrap, useScrollLock } from "./useFocusTrap";

export interface OverlayProps {
  open: boolean;
  onClose: () => void;
  /** Visible heading; also the accessible name. */
  title: ReactNode;
  /** Accessible description shown under the title. */
  description?: ReactNode;
  children?: ReactNode;
  /** Sticky footer (actions). */
  footer?: ReactNode;
  /** Element to focus first (defaults to the first focusable). */
  initialFocus?: RefObject<HTMLElement | null>;
  /** Close when the backdrop is clicked (default true). */
  dismissOnBackdrop?: boolean;
  /** Extra header controls before the close button. */
  headerActions?: ReactNode;
  className?: string;
  /** No padding around the body (for content that draws its own edges). */
  flush?: boolean;
  /** Extra body classes. Additive only: it cannot override the padding, use `flush`. */
  bodyClassName?: string;
}

type Placement = "right" | "bottom" | "center";

function Surface({
  placement,
  open,
  onClose,
  title,
  description,
  children,
  footer,
  initialFocus,
  dismissOnBackdrop = true,
  headerActions,
  className,
  flush,
  bodyClassName,
  style,
}: OverlayProps & { placement: Placement; style?: React.CSSProperties }) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descId = useId();
  useFocusTrap(ref, open, onClose, initialFocus);
  useScrollLock(open);
  if (!open) return null;
  return createPortal(
    <div
      className={cn(
        "fixed inset-0 z-50 flex",
        placement === "right" && "justify-end",
        placement === "bottom" && "items-end",
        placement === "center" && "items-center justify-center p-4",
      )}
    >
      <div
        className="absolute inset-0 bg-overlay"
        aria-hidden
        onClick={dismissOnBackdrop ? onClose : undefined}
      />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        style={style}
        className={cn(
          "relative flex flex-col bg-surface text-text shadow-pop outline-none",
          placement === "right" && "h-full max-w-full border-l border-border safe-pt safe-pb",
          placement === "bottom" &&
            "max-h-[90dvh] w-full rounded-t-xl border-t border-border safe-pb",
          placement === "center" &&
            "max-h-[min(90dvh,720px)] w-full max-w-lg rounded-xl border border-border",
          className,
        )}
      >
        {placement === "bottom" && (
          <div className="flex justify-center pt-2" aria-hidden>
            <div className="h-1 w-10 rounded-full bg-border-strong" />
          </div>
        )}
        <div className="flex items-start gap-2 border-b border-border px-4 py-3">
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="text-base font-semibold leading-6">
              {title}
            </h2>
            {description && (
              <p id={descId} className="text-sm text-muted">
                {description}
              </p>
            )}
          </div>
          {headerActions}
          <IconButton label="Close" icon={<X className="size-4" />} onClick={onClose} />
        </div>
        <div
          className={cn(
            "min-h-0 flex-1 overflow-y-auto overscroll-contain",
            !flush && "px-4 py-3",
            bodyClassName,
          )}
        >
          {children}
        </div>
        {footer && (
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border px-4 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

export interface DrawerProps extends OverlayProps {
  /** Width in px (default 520, the task drawer width). Never wider than the viewport. */
  width?: number;
}

/** Right-side drawer with focus trap, Escape to close, and focus returned to the trigger. */
export function Drawer({ width = 520, ...props }: DrawerProps) {
  return <Surface {...props} placement="right" style={{ width: `min(${width}px, 100vw)` }} />;
}

/** Bottom sheet for mobile; same accessibility behavior as Drawer. */
export function Sheet(props: OverlayProps) {
  return <Surface {...props} placement="bottom" />;
}

/** Centered modal dialog. */
export function Dialog(props: OverlayProps) {
  return <Surface {...props} placement="center" />;
}

export interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  busy?: boolean;
  error?: unknown;
  /** Heading for the error; renders a titled error panel instead of the plain message. */
  errorTitle?: string;
  danger?: boolean;
  /** Icon before the confirm label. */
  confirmIcon?: ReactNode;
  confirmDisabled?: boolean;
  /** Shown next to the actions when the confirm button is disabled. */
  disabledReason?: ReactNode;
  children?: ReactNode;
}

/**
 * Confirmation dialog. Never closes on its own: the caller closes it after the
 * server acknowledges (no optimistic success). It cannot be dismissed while busy.
 */
export function ConfirmDialog({
  open,
  onClose,
  title,
  description,
  confirmLabel,
  onConfirm,
  busy,
  error,
  errorTitle,
  danger = true,
  confirmIcon,
  confirmDisabled,
  disabledReason,
  children,
}: ConfirmDialogProps) {
  return (
    <Dialog
      open={open}
      onClose={busy ? () => undefined : onClose}
      dismissOnBackdrop={!busy}
      title={title}
      description={description}
      footer={
        <>
          {confirmDisabled && disabledReason && (
            <p className="mr-auto min-w-0 flex-1 basis-full text-xs text-muted sm:basis-auto">
              {disabledReason}
            </p>
          )}
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant={danger ? "danger" : "primary"}
            icon={confirmIcon}
            busy={busy}
            disabled={confirmDisabled}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {children}
        {errorTitle ? (
          !!error && <ErrorState compact title={errorTitle} error={errorMessage(error)} />
        ) : (
          <InlineError error={error} />
        )}
      </div>
    </Dialog>
  );
}
