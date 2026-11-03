import { ExtraArg, type Profile, ThinkingLevel } from "@switchyard/protocol";
import { Pencil, Plus, SlidersHorizontal, Trash } from "lucide-react";
import { type FormEvent, useId, useMemo, useState } from "react";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Overlay";
import { EmptyState, LoadingState } from "../../components/ui/states";
import { TextArea, TextInput } from "../../components/ui/TextArea";
import { toast } from "../../components/ui/Toast";
import { apiDelete, apiPatch, apiPost } from "../../sync/api";
import { useSyncStore } from "../../sync/store";
import {
  ConfirmDialog,
  describedBy,
  Field,
  InlineError,
  LastKnownNote,
  SectionPage,
  SelectInput,
  splitLines,
  useHydrated,
} from "./shared";

const TRUST_LABEL: Record<Profile["projectTrust"], string> = {
  ask: "Ask",
  approve: "Approve",
  ignore: "Ignore",
};

const TRUST_HELP: Record<Profile["projectTrust"], string> = {
  ask: "Ask before trusting project-local Pi settings and extensions.",
  approve: "Trust project-local Pi settings and extensions automatically.",
  ignore: "Never load project-local Pi settings or extensions.",
};

const THINKING_LEVELS = ThinkingLevel.options;

const RESOURCES_HELP: Record<NonNullable<Profile["resources"]>, string> = {
  all: "Loads your extensions, skills and prompt templates.",
  vanilla:
    "Starts Pi with --no-extensions --no-skills --no-prompt-templates (also no built-in MCP). Your logins, default model and AGENTS.md still apply, and Switchyard's model, effort, context and command controls keep working.",
};

/** Validate extra args one per line with the protocol schema; returns per-line errors. */
export function validateExtraArgs(lines: string[]): string[] {
  const errors: string[] = [];
  lines.forEach((arg, i) => {
    const r = ExtraArg.safeParse(arg);
    if (!r.success) {
      errors.push(`Line ${i + 1} (${arg}): ${r.error.issues[0]?.message ?? "invalid argument"}`);
    }
  });
  return errors;
}

/** Settings › Pi profiles. */
export function ProfilesSection() {
  const hydrated = useHydrated();
  const profilesById = useSyncStore((s) => s.profiles);
  const projects = useSyncStore((s) => s.projects);
  const profiles = useMemo(
    () => Object.values(profilesById).sort((a, b) => a.name.localeCompare(b.name)),
    [profilesById],
  );
  const [editing, setEditing] = useState<Profile | "new" | null>(null);
  const [deleting, setDeleting] = useState<Profile | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<unknown>(null);

  const remove = async () => {
    if (!deleting) return;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await apiDelete(`/api/profiles/${encodeURIComponent(deleting.id)}`);
      toast.success(`Profile ${deleting.name} deleted`);
      setDeleting(null);
    } catch (e) {
      setDeleteError(e);
    } finally {
      setDeleteBusy(false);
    }
  };

  const usedBy = (id: string) =>
    Object.values(projects)
      .filter((p) => p.defaultProfileId === id)
      .map((p) => p.name);

  return (
    <SectionPage
      title="Pi profiles"
      description="Presets for provider, model, thinking level and Pi flags. Sessions keep a snapshot of the profile they started with."
      actions={
        <Button
          variant="primary"
          icon={<Plus className="size-4" />}
          onClick={() => setEditing("new")}
        >
          New profile
        </Button>
      }
    >
      <LastKnownNote />
      {!hydrated ? (
        <LoadingState label="Loading profiles…" />
      ) : profiles.length === 0 ? (
        <EmptyState
          icon={<SlidersHorizontal className="size-8" />}
          title="No profiles"
          description="Create a profile to choose a provider and model for sessions."
          action={{ label: "New profile", onClick: () => setEditing("new") }}
        />
      ) : (
        <ul className="overflow-hidden rounded-lg border border-border bg-surface">
          {profiles.map((p) => {
            const users = usedBy(p.id);
            return (
              <li
                key={p.id}
                className="flex min-w-0 flex-wrap items-start gap-3 border-b border-border px-4 py-3 last:border-b-0"
              >
                <div className="flex min-w-0 flex-1 flex-col gap-0.5 text-sm">
                  <span className="break-words font-medium">{p.name}</span>
                  <span className="break-words text-muted">
                    {p.provider ?? "Default provider"} / {p.model ?? "default model"} · Thinking{" "}
                    {p.thinking ?? "default"} · Project trust {TRUST_LABEL[p.projectTrust]}
                    {p.resources === "vanilla" && " · Vanilla Pi"}
                  </span>
                  {p.extraArgs.length > 0 && (
                    <span className="break-all font-mono text-xs text-muted">
                      {p.extraArgs.join(" ")}
                    </span>
                  )}
                  {users.length > 0 && (
                    <span className="text-xs text-muted">Default for {users.join(", ")}</span>
                  )}
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    icon={<Pencil className="size-4" />}
                    onClick={() => setEditing(p)}
                  >
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-danger"
                    icon={<Trash className="size-4" />}
                    onClick={() => {
                      setDeleteError(null);
                      setDeleting(p);
                    }}
                  >
                    Delete
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {editing && (
        <ProfileDialog
          key={editing === "new" ? "new" : editing.id}
          profile={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title={deleting ? `Delete ${deleting.name}?` : "Delete profile"}
        confirmLabel="Delete profile"
        busy={deleteBusy}
        error={deleteError}
        onConfirm={remove}
      >
        <p className="text-sm">
          Existing sessions keep their snapshot of this profile. Projects that use it as their
          default must be changed first.
        </p>
      </ConfirmDialog>
    </SectionPage>
  );
}

function ProfileDialog({ profile, onClose }: { profile: Profile | null; onClose: () => void }) {
  const ids = useId();
  const [name, setName] = useState(profile?.name ?? "");
  const [provider, setProvider] = useState(profile?.provider ?? "");
  const [model, setModel] = useState(profile?.model ?? "");
  const [thinking, setThinking] = useState<string>(profile?.thinking ?? "");
  const [trust, setTrust] = useState<Profile["projectTrust"]>(profile?.projectTrust ?? "ask");
  const [resources, setResources] = useState<NonNullable<Profile["resources"]>>(
    profile?.resources ?? "all",
  );
  const [extra, setExtra] = useState((profile?.extraArgs ?? []).join("\n"));
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const args = splitLines(extra);
  const argErrors = validateExtraArgs(args);
  const nameError = submitted && !name.trim() ? "Enter a profile name." : null;
  const argsError = argErrors.length ? argErrors.join("\n") : null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
    if (!name.trim() || argErrors.length) return;
    const body = {
      name: name.trim(),
      provider: provider.trim() || null,
      model: model.trim() || null,
      thinking: thinking || null,
      projectTrust: trust,
      resources,
      extraArgs: args,
    };
    setBusy(true);
    setError(null);
    try {
      if (profile) {
        await apiPatch(`/api/profiles/${encodeURIComponent(profile.id)}`, body);
        toast.success(`Profile ${body.name} saved`);
      } else {
        await apiPost("/api/profiles", body);
        toast.success(`Profile ${body.name} created`);
      }
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const formId = `${ids}-form`;
  return (
    <Dialog
      open
      onClose={busy ? () => undefined : onClose}
      dismissOnBackdrop={!busy}
      title={profile ? `Edit ${profile.name}` : "New profile"}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" form={formId} variant="primary" busy={busy}>
            {profile ? "Save profile" : "Create profile"}
          </Button>
        </>
      }
    >
      <form id={formId} className="flex min-w-0 flex-col gap-4" onSubmit={submit} noValidate>
        <Field id={`${ids}-name`} label="Name" error={nameError}>
          <TextInput
            id={`${ids}-name`}
            value={name}
            onChange={(e) => setName(e.target.value)}
            {...describedBy(`${ids}-name`, { error: nameError })}
          />
        </Field>
        <div className="grid min-w-0 gap-4 sm:grid-cols-2">
          <Field id={`${ids}-provider`} label="Provider" hint="Empty uses Pi's default.">
            <TextInput
              id={`${ids}-provider`}
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
              placeholder="anthropic"
              autoCapitalize="off"
              spellCheck={false}
              {...describedBy(`${ids}-provider`, { hint: true })}
            />
          </Field>
          <Field id={`${ids}-model`} label="Model" hint="Empty uses Pi's default.">
            <TextInput
              id={`${ids}-model`}
              value={model}
              onChange={(e) => setModel(e.target.value)}
              autoCapitalize="off"
              spellCheck={false}
              {...describedBy(`${ids}-model`, { hint: true })}
            />
          </Field>
        </div>
        <div className="grid min-w-0 gap-4 sm:grid-cols-2">
          <Field id={`${ids}-thinking`} label="Thinking">
            <SelectInput
              id={`${ids}-thinking`}
              value={thinking}
              onChange={(e) => setThinking(e.target.value)}
            >
              <option value="">Default (none)</option>
              {THINKING_LEVELS.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </SelectInput>
          </Field>
          <Field id={`${ids}-trust`} label="Project trust" hint={TRUST_HELP[trust]}>
            <SelectInput
              id={`${ids}-trust`}
              value={trust}
              onChange={(e) => setTrust(e.target.value as Profile["projectTrust"])}
              {...describedBy(`${ids}-trust`, { hint: true })}
            >
              {(Object.keys(TRUST_LABEL) as Profile["projectTrust"][]).map((t) => (
                <option key={t} value={t}>
                  {TRUST_LABEL[t]}
                </option>
              ))}
            </SelectInput>
          </Field>
        </div>
        <Field id={`${ids}-resources`} label="Resources" hint={RESOURCES_HELP[resources]}>
          <SelectInput
            id={`${ids}-resources`}
            value={resources}
            onChange={(e) => setResources(e.target.value as NonNullable<Profile["resources"]>)}
            {...describedBy(`${ids}-resources`, { hint: true })}
          >
            <option value="all">Your Pi setup</option>
            <option value="vanilla">Vanilla Pi</option>
          </SelectInput>
        </Field>
        <Field
          id={`${ids}-extra`}
          label="Extra Pi arguments"
          hint="One long flag per line, e.g. --max-turns=40. Session, mode and extension flags are managed by Switchyard."
          error={argsError}
        >
          <TextArea
            id={`${ids}-extra`}
            value={extra}
            minRows={3}
            onChange={(e) => setExtra(e.target.value)}
            className="font-mono"
            autoCapitalize="off"
            spellCheck={false}
            {...describedBy(`${ids}-extra`, { hint: true, error: argsError })}
          />
        </Field>
        <InlineError error={error} />
      </form>
    </Dialog>
  );
}
