import type { Host } from "@switchyard/protocol";
import { Save } from "lucide-react";
import { useId, useState } from "react";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { Field, fieldControlProps } from "../../components/ui/Field";
import { InlineError } from "../../components/ui/states";
import { TextInput } from "../../components/ui/TextArea";
import { toast } from "../../components/ui/Toast";
import { apiPatch } from "../../sync/api";

export function checkoutRootProblem(value: string): string | null {
  const path = value.trim();
  if (path.length > 1024 || /[\r\n\0]/.test(value)) return "Enter one directory path.";
  if (path && path !== "~" && !path.startsWith("/") && !path.startsWith("~/")) {
    return "Use an absolute path or a path starting with ~/, like ~/Projects.";
  }
  return null;
}

export function CheckoutLocationCard({ host }: { host: Host }) {
  const id = useId();
  const saved = host.checkoutRoot ?? "";
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const text = draft ?? saved;
  const problem = checkoutRootProblem(text);
  const suggestions = host.checkoutRoot === null ? (host.projectFolders ?? []) : [];

  return (
    <Card
      title="Checkout location"
      description="New managed checkouts go here. Changing the location does not scan, move or remove any existing checkouts."
    >
      {host.checkoutRoot === undefined ? (
        <p className="text-sm text-muted">
          Update the coordinator before setting a checkout location.
        </p>
      ) : (
        <form
          className="flex min-w-0 flex-col gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            if (saving || problem || text.trim() === saved) return;
            setSaving(true);
            setError(null);
            try {
              await apiPatch(`/api/hosts/${encodeURIComponent(host.id)}`, {
                checkoutRoot: text.trim() || null,
              });
              setDraft(null);
              toast.success("Checkout location saved");
            } catch (err) {
              setError(err);
            } finally {
              setSaving(false);
            }
          }}
        >
          <Field
            id={id}
            label="Directory on this host"
            hint="Use one absolute or ~/ path. Leave blank to disable new managed clones."
            error={problem}
          >
            <TextInput
              id={id}
              value={text}
              disabled={saving}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="~/Projects"
              className="font-mono"
              spellCheck={false}
              autoCapitalize="off"
              autoComplete="off"
              {...fieldControlProps(id, { hint: true, error: problem })}
            />
          </Field>
          {suggestions.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 text-sm text-muted">
              Previous folders:
              {[...new Set(suggestions)].map((path) => (
                <Button key={path} size="sm" disabled={saving} onClick={() => setDraft(path)}>
                  {path}
                </Button>
              ))}
            </div>
          )}
          {!host.checkoutProvision && (
            <p className="text-sm text-muted">
              Update this host agent to prepare checkouts from Switchyard. Existing clones can still
              be attached manually.
            </p>
          )}
          <InlineError error={error} />
          <div>
            <Button
              type="submit"
              variant="primary"
              icon={<Save className="size-4" />}
              busy={saving}
              disabled={text.trim() === saved || !!problem}
            >
              Save location
            </Button>
          </div>
        </form>
      )}
    </Card>
  );
}
