import type {
  PolicyModelClassification,
  PolicyPhase,
  PolicyRule,
  PolicyScope,
  PolicySettings,
  PolicyTestResult,
} from "@switchyard/protocol";
import { useCallback, useEffect, useState } from "react";
import { Button } from "../../components/ui/Button";
import { ApiClientError, errorMessage } from "../../sync/api";
import { useSyncStore } from "../../sync/store";
import { policiesApi } from "./policiesApi";
import {
  CONTINUATION_BUDGET_HELP,
  validateRule,
  validateSettings,
  validateTest,
  verdictLabel,
} from "./policyLogic";
import { SectionPage } from "./shared";

const control = "w-full rounded-md border border-border bg-surface px-2 py-1 text-sm";
type Draft = {
  scope: PolicyScope;
  scopeId: string;
  name: string;
  priority: string;
  enabled: boolean;
  phases: PolicyPhase[];
  expression: string;
};
const blank = (): Draft => ({
  scope: "server",
  scopeId: "",
  name: "",
  priority: "0",
  enabled: true,
  phases: ["tool_call"],
  expression: "",
});
const draftOf = (r: PolicyRule): Draft => ({
  ...r,
  scopeId: r.scopeId ?? "",
  priority: String(r.priority),
});

export function PoliciesSection() {
  const sessions = useSyncStore((s) => s.sessions);
  const profiles = useSyncStore((s) => s.profiles);
  const [rules, setRules] = useState<PolicyRule[]>([]);
  const [settings, setSettings] = useState<PolicySettings | null>(null);
  const [models, setModels] = useState<PolicyModelClassification[]>([]);
  const [editing, setEditing] = useState<PolicyRule | null>(null);
  const [draft, setDraft] = useState<Draft>(blank);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [sessionId, setSessionId] = useState("");
  const [phase, setPhase] = useState<PolicyPhase>("tool_call");
  const [action, setAction] = useState("bash");
  const [args, setArgs] = useState("{}");
  const [result, setResult] = useState<PolicyTestResult | null>(null);
  const [testError, setTestError] = useState("");
  const refresh = useCallback(async () => {
    const [nextRules, nextSettings] = await Promise.all([
      policiesApi.list(),
      policiesApi.settings(),
    ]);
    setRules(nextRules);
    setSettings(nextSettings);
    setModels(nextSettings.modelClassifications);
  }, []);
  useEffect(() => {
    void refresh().catch((e) => setError(errorMessage(e)));
  }, [refresh]);
  const run = async (fn: () => Promise<void>, isTest = false) => {
    setBusy(true);
    setError("");
    if (isTest) setTestError("");
    try {
      await fn();
    } catch (e) {
      const detail =
        e instanceof ApiClientError && e.details !== undefined
          ? ` ${JSON.stringify(e.details)}`
          : "";
      (isTest ? setTestError : setError)(`${errorMessage(e)}${detail}`);
    } finally {
      setBusy(false);
    }
  };
  const saveRule = () =>
    run(async () => {
      if (!draft.priority.trim()) throw new Error("Priority: enter a whole number.");
      const parsed = validateRule({
        ...draft,
        scopeId: draft.scope === "server" ? null : draft.scopeId,
        priority: Number(draft.priority),
      });
      if (!parsed.success)
        throw new Error(
          parsed.error.issues.map((i) => `${i.path.join(".") || "Rule"}: ${i.message}`).join("; "),
        );
      if (editing) {
        const { name, priority, enabled, phases, expression } = parsed.data;
        await policiesApi.update(editing.id, {
          expectedRevision: editing.revision,
          name,
          priority,
          enabled,
          phases,
          expression,
        });
      } else await policiesApi.create(parsed.data);
      setEditing(null);
      setDraft(blank());
      await refresh();
    });
  const saveModels = () =>
    run(async () => {
      if (!settings) return;
      const parsed = validateSettings({
        expectedRevision: settings.revision,
        modelClassifications: models,
      });
      if (!parsed.success)
        throw new Error(
          parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
        );
      await policiesApi.updateSettings(parsed.data);
      await refresh();
    });
  const test = () =>
    run(async () => {
      setResult(null);
      let parsedArgs: unknown;
      try {
        parsedArgs = JSON.parse(args);
      } catch {
        throw new Error("Sample arguments must be valid JSON.");
      }
      const parsed = validateTest({
        sessionId,
        phase,
        tool: phase === "tool_call" ? { name: action, args: parsedArgs } : null,
        request: phase === "request" ? { method: action, args: parsedArgs } : null,
      });
      if (!parsed.success)
        throw new Error(
          parsed.error.issues.map((i) => `${i.path.join(".") || "Test"}: ${i.message}`).join("; "),
        );
      setResult(await policiesApi.test(parsed.data));
    }, true);
  return (
    <SectionPage
      title="Policies"
      description="Guardrails for tool calls and API requests; not an OS sandbox."
    >
      <p className="text-sm text-muted">{CONTINUATION_BUDGET_HELP}</p>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <section className="flex flex-col gap-2">
        <h2 className="font-semibold">Rules</h2>
        {rules.length === 0 && <p className="text-sm text-muted">No rules.</p>}
        {rules.map((r) => (
          <article key={r.id} className="rounded-md border border-border p-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <strong>{r.name}</strong>
              <span>
                {r.builtIn ? "Built-in" : "Custom"} · {r.scope}
                {r.scopeId ? `: ${r.scopeId}` : ""} · priority {r.priority} ·{" "}
                {r.phases.map((p) => (p === "tool_call" ? "Tool call" : "API request")).join(", ")}
              </span>
              <Button
                size="sm"
                onClick={() => {
                  setEditing(r);
                  setDraft(draftOf(r));
                }}
              >
                Edit
              </Button>
              <Button
                size="sm"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await policiesApi.update(r.id, {
                      expectedRevision: r.revision,
                      enabled: !r.enabled,
                    });
                    await refresh();
                  })
                }
              >
                {r.enabled ? "Disable" : "Enable"}
              </Button>
              {!r.builtIn && (
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    if (window.confirm(`Delete ${r.name}?`))
                      void run(async () => {
                        await policiesApi.remove(r.id, r.revision);
                        await refresh();
                      });
                  }}
                >
                  Delete
                </Button>
              )}
            </div>
            <p>{r.enabled ? "Enabled" : "Disabled"}</p>
            <pre className="overflow-auto whitespace-pre-wrap break-words">{r.expression}</pre>
          </article>
        ))}
      </section>
      <section className="flex flex-col gap-2">
        <h2 className="font-semibold">{editing ? `Edit ${editing.name}` : "New rule"}</h2>
        <label>
          Name
          <input
            className={control}
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
        </label>
        <label>
          Scope
          <select
            className={control}
            disabled={!!editing}
            value={draft.scope}
            onChange={(e) =>
              setDraft({ ...draft, scope: e.target.value as PolicyScope, scopeId: "" })
            }
          >
            <option value="server">Server</option>
            <option value="profile">Profile</option>
            <option value="session">Session</option>
          </select>
        </label>
        {draft.scope !== "server" && (
          <label>
            {draft.scope === "profile" ? "Profile" : "Session"}
            <select
              className={control}
              disabled={!!editing}
              value={draft.scopeId}
              onChange={(e) => setDraft({ ...draft, scopeId: e.target.value })}
            >
              <option value="">Choose…</option>
              {draft.scope === "profile"
                ? Object.values(profiles).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))
                : Object.values(sessions).map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.title}
                    </option>
                  ))}
            </select>
          </label>
        )}
        <label>
          Priority
          <input
            className={control}
            type="number"
            value={draft.priority}
            onChange={(e) => setDraft({ ...draft, priority: e.target.value })}
          />
        </label>
        <label>
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
          />{" "}
          Enabled
        </label>
        <fieldset>
          <legend>Phases</legend>
          {(
            [
              ["tool_call", "Tool call"],
              ["request", "API request"],
            ] as const
          ).map(([value, label]) => (
            <label key={value} className="mr-4">
              <input
                type="checkbox"
                checked={draft.phases.includes(value)}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    phases: e.target.checked
                      ? [...draft.phases, value]
                      : draft.phases.filter((p) => p !== value),
                  })
                }
              />{" "}
              {label}
            </label>
          ))}
        </fieldset>
        <label>
          CEL expression
          <textarea
            className={control}
            rows={5}
            value={draft.expression}
            onChange={(e) => setDraft({ ...draft, expression: e.target.value })}
          />
        </label>
        <div className="flex gap-2">
          <Button disabled={busy} onClick={saveRule}>
            Save rule
          </Button>
          {editing && (
            <Button
              onClick={() => {
                setEditing(null);
                setDraft(blank());
              }}
            >
              Cancel
            </Button>
          )}
        </div>
      </section>
      <section className="flex flex-col gap-2">
        <h2 className="font-semibold">Model classification</h2>
        <p className="text-sm text-muted">Unknown models count as expensive.</p>
        {models.map((m, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: controlled rows have no persisted identity
          <div key={`${i}-${settings?.revision}`} className="flex flex-wrap gap-2">
            <label>
              Provider
              <input
                className={control}
                value={m.provider}
                onChange={(e) =>
                  setModels(
                    models.map((x, j) => (j === i ? { ...x, provider: e.target.value } : x)),
                  )
                }
              />
            </label>
            <label>
              Model ID
              <input
                className={control}
                value={m.modelId}
                onChange={(e) =>
                  setModels(models.map((x, j) => (j === i ? { ...x, modelId: e.target.value } : x)))
                }
              />
            </label>
            <label>
              Classification
              <select
                className={control}
                value={m.classification}
                onChange={(e) =>
                  setModels(
                    models.map((x, j) =>
                      j === i
                        ? { ...x, classification: e.target.value as "cheap" | "expensive" }
                        : x,
                    ),
                  )
                }
              >
                <option value="cheap">Cheap</option>
                <option value="expensive">Expensive</option>
              </select>
            </label>
            <Button onClick={() => setModels(models.filter((_, j) => i !== j))}>Remove</Button>
          </div>
        ))}
        <div className="flex gap-2">
          <Button
            onClick={() =>
              setModels([...models, { provider: "", modelId: "", classification: "expensive" }])
            }
          >
            Add model
          </Button>
          <Button disabled={busy || !settings} onClick={saveModels}>
            Save classifications
          </Button>
        </div>
      </section>
      <section className="flex flex-col gap-2">
        <h2 className="font-semibold">Test rules</h2>
        <p className="text-sm text-muted">
          Read-only policy test. The sample command is not executed. No approval or counter update
          is applied; a test result is not permission to execute later.
        </p>
        {testError && (
          <p role="alert" className="text-sm text-danger">
            {testError}
          </p>
        )}
        <label>
          Session
          <select
            className={control}
            value={sessionId}
            onChange={(e) => setSessionId(e.target.value)}
          >
            <option value="">Choose…</option>
            {Object.values(sessions).map((s) => (
              <option key={s.id} value={s.id}>
                {s.title}
              </option>
            ))}
          </select>
        </label>
        <label>
          Phase
          <select
            className={control}
            value={phase}
            onChange={(e) => {
              const p = e.target.value as PolicyPhase;
              setPhase(p);
              setAction(p === "tool_call" ? "bash" : "task.create");
              setResult(null);
            }}
          >
            <option value="tool_call">Tool call</option>
            <option value="request">API request</option>
          </select>
        </label>
        {phase === "tool_call" ? (
          <label>
            Tool name
            <input className={control} value={action} onChange={(e) => setAction(e.target.value)} />
          </label>
        ) : (
          <label>
            Action
            <select className={control} value={action} onChange={(e) => setAction(e.target.value)}>
              {["task.create", "message.send", "inbox.read", "run.continue"].map((a) => (
                <option key={a}>{a}</option>
              ))}
            </select>
          </label>
        )}
        <label>
          Sample arguments (JSON object)
          <textarea
            className={control}
            rows={4}
            value={args}
            onChange={(e) => setArgs(e.target.value)}
          />
        </label>
        <Button disabled={busy} onClick={test}>
          Test
        </Button>
        {result && (
          <div className="rounded-md border border-border p-3 text-sm">
            <p>
              <strong>{verdictLabel(result.verdict)}</strong>
              {result.reason && `: ${result.reason}`}
            </p>
            <p>{result.enforcement.explanation}</p>
            <p>
              Enforced phases: {result.enforcement.phases.join(", ") || "Not enforced"}.
              Pre-provider: Not enforced.
            </p>
            <ul>
              {result.trace.map((t) => (
                <li key={t.ruleId}>
                  {t.ruleId} (revision {t.ruleRevision}): {verdictLabel(t.verdict)}
                  {t.reason && ` — ${t.reason}`}
                  {t.granted && " · granted"}
                  {t.overridden && " · overridden"}
                </li>
              ))}
            </ul>
            <p>Proposed updates (not applied):</p>
            <pre className="overflow-auto">
              {JSON.stringify(result.proposedStateUpdates, null, 2)}
            </pre>
          </div>
        )}
      </section>
    </SectionPage>
  );
}
