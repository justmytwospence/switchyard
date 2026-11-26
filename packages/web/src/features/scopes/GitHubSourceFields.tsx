import type { Host } from "@switchyard/protocol";
import { useId } from "react";
import { Field } from "../../components/ui/Field";
import { Select } from "../../components/ui/Select";
import { SwitchRow } from "../../components/ui/Switch";
import { TextArea, TextInput } from "../../components/ui/TextArea";
import type { GitHubSourceDraft, GitHubSourceDraftErrors } from "./githubSourceLogic";

/** The fields of a GitHub source, inside the scope form. The name belongs to the form. */
export function GitHubSourceFields({
  draft,
  errors,
  set,
  hosts,
  columns,
}: {
  draft: GitHubSourceDraft;
  errors: GitHubSourceDraftErrors;
  set: <K extends keyof GitHubSourceDraft>(k: K, v: GitHubSourceDraft[K]) => void;
  hosts: Host[];
  /** The board's column names, for the column inputs' suggestions. */
  columns: string[];
}) {
  const columnsId = useId();
  const hasBoard = draft.board.trim() !== "";
  return (
    <div data-testid="github-source-form" className="flex flex-col gap-3">
      <Field label="Host" hint="Its gh login reads your issues." error={errors.hostId}>
        {(p) => (
          <Select {...p} value={draft.hostId} onChange={(e) => set("hostId", e.target.value)}>
            <option value="">Choose a host</option>
            {hosts.map((h) => (
              <option key={h.id} value={h.id}>
                {h.name}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field
        label="GitHub owner"
        hint="An organization or user, such as fieldgoalco."
        error={errors.owner}
      >
        {(p) => (
          <TextInput
            {...p}
            value={draft.owner}
            spellCheck={false}
            onChange={(e) => set("owner", e.target.value)}
          />
        )}
      </Field>
      <Field
        label="Repositories"
        optional
        hint="One owner/name per line. Leave empty for every repository of the owner."
        error={errors.repositories}
      >
        {(p) => (
          <TextArea
            {...p}
            rows={3}
            value={draft.repositories}
            spellCheck={false}
            onChange={(e) => set("repositories", e.target.value)}
          />
        )}
      </Field>
      <Field
        label="Repositories of other owners"
        optional
        hint="One owner/name per line. Their projects join this scope, and issues assigned to you there are tracked too."
        error={errors.extraRepositories}
      >
        {(p) => (
          <TextArea
            {...p}
            rows={2}
            value={draft.extraRepositories}
            spellCheck={false}
            onChange={(e) => set("extraRepositories", e.target.value)}
          />
        )}
      </Field>
      <fieldset className="flex flex-col gap-3">
        <legend className="text-sm font-semibold">Projects board</legend>
        <Field
          label="Board number"
          optional
          hint="A GitHub Projects board of the owner. Needs the project permission on your gh login: gh auth refresh -s project."
          error={errors.board}
        >
          {(p) => (
            <TextInput
              {...p}
              inputMode="numeric"
              value={draft.board}
              onChange={(e) => set("board", e.target.value)}
            />
          )}
        </Field>
        {hasBoard && (
          <>
            <datalist id={columnsId}>
              {columns.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
            <Field label="Issues to follow" hint="On the board, issues need no assignee.">
              {(p) => (
                <Select
                  {...p}
                  value={draft.follow}
                  onChange={(e) => set("follow", e.target.value as GitHubSourceDraft["follow"])}
                >
                  <option value="assigned">Assigned to me</option>
                  <option value="board">Every open issue on the board</option>
                </Select>
              )}
            </Field>
            <Field label="Status field">
              {(p) => (
                <TextInput
                  {...p}
                  value={draft.statusField}
                  onChange={(e) => set("statusField", e.target.value)}
                />
              )}
            </Field>
            <Field label="Column when work starts" optional>
              {(p) => (
                <TextInput
                  {...p}
                  list={columnsId}
                  value={draft.onStart}
                  onChange={(e) => set("onStart", e.target.value)}
                />
              )}
            </Field>
            <Field label="Column when a pull request opens" optional>
              {(p) => (
                <TextInput
                  {...p}
                  list={columnsId}
                  value={draft.onReview}
                  onChange={(e) => set("onReview", e.target.value)}
                />
              )}
            </Field>
            <Field
              label="Backlog columns"
              optional
              hint="Cards in these columns are not tracked until they have a branch or pull request. Separate names with commas."
              error={errors.backlog}
            >
              {(p) => (
                <TextInput
                  {...p}
                  value={draft.backlog}
                  onChange={(e) => set("backlog", e.target.value)}
                />
              )}
            </Field>
            <Field
              label="Priority field"
              optional
              hint="A single-select field, such as Priority. Not-started issues are listed by it."
            >
              {(p) => (
                <TextInput
                  {...p}
                  value={draft.priorityField}
                  onChange={(e) => set("priorityField", e.target.value)}
                />
              )}
            </Field>
            <SwitchRow
              label="Move cards on GitHub"
              description={
                draft.follow === "board"
                  ? "Cards assigned to you or to nobody, only the status field, and only from the column Switchyard last saw."
                  : "Only cards assigned to you, only the status field, and only from the column Switchyard last saw."
              }
              checked={draft.writeBack}
              onChange={(v) => set("writeBack", v)}
            />
            {draft.writeBack && (
              <SwitchRow
                label="Also move cards assigned to others too"
                checked={draft.moveShared}
                onChange={(v) => set("moveShared", v)}
              />
            )}
          </>
        )}
      </fieldset>
      <SwitchRow
        label="Make worktrees for issue branches"
        description="Off: Switchyard only links the worktrees you make and never creates one."
        checked={draft.worktrees}
        onChange={(v) => set("worktrees", v)}
      />
      <SwitchRow
        label="Sync this scope"
        checked={draft.enabled}
        onChange={(v) => set("enabled", v)}
      />
      <p className="text-xs text-muted">
        Its projects are the ones in Settings › Projects whose repositories this covers.
      </p>
    </div>
  );
}
