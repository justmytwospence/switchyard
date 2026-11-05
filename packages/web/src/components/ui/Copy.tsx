import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "./Button";
import { toast } from "./Toast";

/** Copy text to the clipboard with a toast; pass `false` to stay silent on success. */
export async function copyText(
  text: string,
  success: string | false = "Copied to clipboard",
): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    if (success) toast.success(success);
    return true;
  } catch {
    toast.error("Could not copy. Select the text and copy it manually.");
    return false;
  }
}

export function CopyButton({
  text,
  label = "Copy",
  toastMessage,
  size = "sm",
}: {
  text: string;
  label?: string;
  toastMessage?: string;
  size?: "sm" | "md";
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  return (
    <Button
      size={size}
      icon={copied ? <Check className="size-4" /> : <Copy className="size-4" />}
      onClick={async () => {
        if (await copyText(text, toastMessage)) {
          setCopied(true);
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => setCopied(false), 2000);
        }
      }}
    >
      {copied ? "Copied" : label}
    </Button>
  );
}

/** A monospace command or URL with a copy button; wraps instead of overflowing. */
export function CopyBlock({
  text,
  label,
  copyLabel = "Copy",
}: {
  text: string;
  /** Accessible name of the code block. */
  label: string;
  copyLabel?: string;
}) {
  return (
    <figure className="m-0 flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start">
      <figcaption className="sr-only">{label}</figcaption>
      <pre className="min-w-0 flex-1 whitespace-pre-wrap break-all rounded-md border border-border bg-surface-2 px-3 py-2 font-mono text-sm">
        {text}
      </pre>
      <CopyButton text={text} label={copyLabel} />
    </figure>
  );
}
