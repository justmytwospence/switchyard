import type { StatementSync } from "node:sqlite";
import {
  type AdapterInfo,
  type AttentionItem,
  type Automation,
  type Checkout,
  type Device,
  type EventData,
  EventDataSchemas,
  type EventEnvelope,
  type EventScope,
  type EventType,
  type Host,
  type Interaction,
  newId,
  type Occurrence,
  type Panel,
  type Profile,
  type Project,
  type Run,
  type Session,
  SwitchyardError,
  type SyncState,
  type Task,
  type TranscriptItem,
  type Workspace,
} from "@switchyard/protocol";
import type { Db, SqlValue } from "./db/index.js";
import type { EventHub } from "./event-hub.js";

export type Clock = () => Date;

type Columns<T> = Record<string, (e: T) => SqlValue>;

/** Shared statement cache keyed by SQL text. */
class Statements {
  private cache = new Map<string, StatementSync>();
  constructor(private db: Db) {}
  get(sql: string): StatementSync {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.cache.set(sql, s);
    }
    return s;
  }
}

/**
 * Generic repository for an entity stored as JSON with indexed scalar columns. `columns` are
 * written on insert and update; `insertOnly` only on insert.
 */
export class JsonRepo<T extends { id: string }> {
  constructor(
    private readonly st: Statements,
    readonly table: string,
    private readonly label: string,
    private readonly columns: Columns<T>,
    private readonly insertOnly: Columns<T> = {},
  ) {}

  get(id: string): T | undefined {
    const row = this.st.get(`SELECT json FROM ${this.table} WHERE id = ?`).get(id) as
      | { json: string }
      | undefined;
    return row ? (JSON.parse(row.json) as T) : undefined;
  }

  /** Like `get` but throws `not_found`. */
  require(id: string): T {
    const e = this.get(id);
    if (!e) throw new SwitchyardError("not_found", `${this.label} ${id} not found`);
    return e;
  }

  /** List with an optional SQL `WHERE` fragment over the indexed columns. */
  list(where?: string, params: SqlValue[] = [], orderBy = "rowid"): T[] {
    const sql = `SELECT json FROM ${this.table}${where ? ` WHERE ${where}` : ""} ORDER BY ${orderBy}`;
    return (this.st.get(sql).all(...params) as { json: string }[]).map(
      (r) => JSON.parse(r.json) as T,
    );
  }

  count(where?: string, params: SqlValue[] = []): number {
    const sql = `SELECT COUNT(*) AS n FROM ${this.table}${where ? ` WHERE ${where}` : ""}`;
    return (this.st.get(sql).get(...params) as { n: number }).n;
  }

  /**
   * Update by id, or insert when missing. `extra` columns are written in both cases when given
   * (SQLite checks NOT NULL on the insert row even for ON CONFLICT, so this is UPDATE-then-INSERT).
   */
  upsert(e: T, extra: Record<string, SqlValue> = {}): T {
    const cols = Object.keys(this.columns);
    const ext = Object.keys(extra);
    const setCols = ["json", ...cols, ...ext];
    const setValues: SqlValue[] = [
      JSON.stringify(e),
      ...cols.map((c) => this.columns[c]!(e)),
      ...ext.map((c) => extra[c]!),
    ];
    const upd = this.st
      .get(`UPDATE ${this.table} SET ${setCols.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`)
      .run(...setValues, e.id);
    if (Number(upd.changes) > 0) return e;
    const ins = Object.keys(this.insertOnly);
    const all = ["id", ...setCols, ...ins];
    this.st
      .get(
        `INSERT INTO ${this.table} (${all.join(", ")}) VALUES (${all.map(() => "?").join(", ")})`,
      )
      .run(e.id, ...setValues, ...ins.map((c) => this.insertOnly[c]!(e)));
    return e;
  }

  delete(id: string): boolean {
    return Number(this.st.get(`DELETE FROM ${this.table} WHERE id = ?`).run(id).changes) > 0;
  }
}

export interface EnrollmentRow {
  id: string;
  kind: "device" | "host";
  token_hash: string;
  expires_at: string;
  used_at: string | null;
  result_id: string | null;
  created_by: string | null;
  created_at: string;
}

export interface PresenceRow {
  deviceId: string;
  foregroundUntil: string | null;
  interactedAt: string | null;
  viewingSessionId: string | null;
  updatedAt: string;
}

export interface PushSubscriptionRow {
  deviceId: string;
  endpoint: string;
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } };
  createdAt: string;
}

export interface NotificationRow {
  sessionId: string;
  attentionId: string | null;
  sentToDevice: string | null;
  sentAt: string | null;
  tag: string | null;
}

const ACTIVE_RUN_STATES = [
  "queued",
  "dispatching",
  "uncertain",
  "running",
  "waiting_input",
  "checking",
];

/**
 * Repository layer over SQLite. All writes that should be observable go through `tx()` and
 * `appendEvent()`; events are published to the hub only after the outermost transaction commits,
 * in global seq order, including writes made by listeners.
 */
export class Store {
  readonly st: Statements;
  readonly hosts: JsonRepo<Host>;
  readonly devices: JsonRepo<Device>;
  readonly projects: JsonRepo<Project>;
  readonly checkouts: JsonRepo<Checkout>;
  readonly workspaces: JsonRepo<Workspace>;
  readonly profiles: JsonRepo<Profile>;
  readonly sessions: JsonRepo<Session>;
  readonly interactions: JsonRepo<Interaction>;
  readonly tasks: JsonRepo<Task>;
  readonly runs: JsonRepo<Run>;
  readonly automations: JsonRepo<Automation>;
  readonly occurrences: JsonRepo<Occurrence>;
  readonly attention: JsonRepo<AttentionItem>;

  private depth = 0;
  private pending: EventEnvelope[] = [];
  private afterCommitFns: (() => void)[] = [];
  /** Committed batches waiting to be published, in commit order. */
  private outbox: { events: EventEnvelope[]; fns: (() => void)[] }[] = [];
  private publishing = false;

  constructor(
    readonly db: Db,
    readonly hub: EventHub,
    readonly clock: Clock = () => new Date(),
  ) {
    const st = new Statements(db);
    this.st = st;
    const now = () => this.nowIso();
    this.hosts = new JsonRepo<Host>(
      st,
      "hosts",
      "Host",
      { name: (h) => h.name, revoked_at: (h) => h.revokedAt },
      { created_at: (h) => h.createdAt },
    );
    this.devices = new JsonRepo<Device>(
      st,
      "devices",
      "Device",
      {
        name: (d) => d.name,
        kind: (d) => d.kind,
        revoked_at: (d) => d.revokedAt,
        last_seen_at: (d) => d.lastSeenAt,
      },
      { created_at: (d) => d.createdAt },
    );
    this.projects = new JsonRepo<Project>(
      st,
      "projects",
      "Project",
      { repo_identity: (p) => p.repoIdentity, updated_at: (p) => p.updatedAt },
      { created_at: (p) => p.createdAt },
    );
    this.checkouts = new JsonRepo<Checkout>(st, "checkouts", "Checkout", {
      project_id: (c) => c.projectId,
      host_id: (c) => c.hostId,
      path: (c) => c.path,
    });
    this.workspaces = new JsonRepo<Workspace>(st, "workspaces", "Workspace", {
      project_id: (w) => w.projectId,
      checkout_id: (w) => w.checkoutId,
      host_id: (w) => w.hostId,
      path: (w) => w.path,
      archived_at: (w) => w.archivedAt,
    });
    this.profiles = new JsonRepo<Profile>(
      st,
      "profiles",
      "Profile",
      { name: (p) => p.name },
      { created_at: () => now() },
    );
    this.sessions = new JsonRepo<Session>(st, "sessions", "Session", {
      host_id: (s) => s.hostId,
      project_id: (s) => s.projectId,
      workspace_id: (s) => s.workspaceId,
      task_id: (s) => s.taskId,
      run_id: (s) => s.runId,
      runtime: (s) => s.runtime,
      native_session_file: (s) => s.nativeHandle?.sessionFile ?? null,
      archived_at: (s) => s.archivedAt,
      last_activity_at: (s) => s.lastActivityAt,
    });
    this.interactions = new JsonRepo<Interaction>(
      st,
      "interactions",
      "Interaction",
      {
        session_id: (i) => i.sessionId,
        state: (i) => i.state,
        revision: (i) => i.revision,
      },
      { created_at: (i) => i.createdAt },
    );
    this.tasks = new JsonRepo<Task>(
      st,
      "tasks",
      "Task",
      {
        project_id: (t) => t.projectId,
        state: (t) => t.state,
        current_run_id: (t) => t.currentRunId,
        session_id: (t) => t.sessionId,
        automation_id: (t) => (t.origin.kind === "automation" ? t.origin.automationId : null),
        grouping_key: (t) => t.groupingKey,
        updated_at: (t) => t.updatedAt,
      },
      { created_at: (t) => t.createdAt },
    );
    this.runs = new JsonRepo<Run>(
      st,
      "runs",
      "Run",
      {
        task_id: (r) => r.taskId,
        session_id: (r) => r.sessionId,
        host_id: (r) => r.hostId,
        dispatch_key: (r) => r.dispatchKey,
        state: (r) => r.state,
        updated_at: (r) => r.updatedAt,
      },
      { created_at: (r) => r.createdAt },
    );
    this.automations = new JsonRepo<Automation>(
      st,
      "automations",
      "Automation",
      {
        project_id: (a) => a.projectId,
        enabled: (a) => (a.enabled ? 1 : 0),
        updated_at: (a) => a.updatedAt,
      },
      { created_at: (a) => a.createdAt },
    );
    this.occurrences = new JsonRepo<Occurrence>(
      st,
      "occurrences",
      "Occurrence",
      { automation_id: (o) => o.automationId, state: (o) => o.state, task_id: (o) => o.taskId },
      { key: (o) => o.key, created_at: (o) => o.createdAt },
    );
    this.attention = new JsonRepo<AttentionItem>(
      st,
      "attention",
      "Attention item",
      {
        session_id: (a) => a.sessionId,
        task_id: (a) => a.taskId,
        project_id: (a) => a.projectId,
        reason: (a) => a.reason,
        interaction_id: (a) => a.interactionId,
        resolved_at: (a) => a.resolvedAt,
      },
      { created_at: (a) => a.createdAt },
    );
  }

  now(): Date {
    return this.clock();
  }

  nowIso(): string {
    return this.clock().toISOString();
  }

  get inTransaction(): boolean {
    return this.depth > 0;
  }

  /**
   * Run `fn` in a `BEGIN IMMEDIATE` transaction (nested calls join the outer one). After the
   * outermost commit, queued events are published and `afterCommit` callbacks run, in global seq
   * order, including writes made by listeners while a batch is being published.
   * `fn` must be synchronous.
   */
  tx<T>(fn: () => T): T {
    if (this.depth > 0) {
      this.depth++;
      try {
        return fn();
      } finally {
        this.depth--;
      }
    }
    this.db.exec("BEGIN IMMEDIATE");
    this.depth = 1;
    let result: T;
    try {
      result = fn();
      if (result && typeof (result as unknown as Promise<unknown>).then === "function") {
        throw new Error("Store.tx callback must be synchronous");
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.depth = 0;
      this.pending = [];
      this.afterCommitFns = [];
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // already rolled back
      }
      throw err;
    }
    this.depth = 0;
    this.outbox.push({ events: this.pending, fns: this.afterCommitFns });
    this.pending = [];
    this.afterCommitFns = [];
    this.drain();
    return result;
  }

  /**
   * Publish committed batches in FIFO order. Only the outermost caller drains; a listener that
   * commits while we publish appends its batch, which goes out after the current one.
   */
  private drain(): void {
    if (this.publishing) return;
    this.publishing = true;
    try {
      for (let b = this.outbox.shift(); b; b = this.outbox.shift()) {
        for (const e of b.events) this.publish(e);
        for (const f of b.fns) {
          try {
            f();
          } catch (err) {
            this.hub.onListenerError("afterCommit", err);
          }
        }
      }
    } finally {
      this.publishing = false;
    }
  }

  /**
   * Run `fn` inside a SAVEPOINT within the current transaction. On error, its writes and the
   * events it appended are discarded and the error is returned instead of thrown.
   */
  savepoint<T>(fn: () => T): { ok: true; value: T } | { ok: false; error: unknown } {
    if (this.depth === 0) throw new Error("savepoint() requires an open transaction");
    const mark = this.pending.length;
    const fnMark = this.afterCommitFns.length;
    this.db.exec("SAVEPOINT sy_sp");
    try {
      const value = fn();
      this.db.exec("RELEASE sy_sp");
      return { ok: true, value };
    } catch (error) {
      this.db.exec("ROLLBACK TO sy_sp");
      this.db.exec("RELEASE sy_sp");
      this.pending.length = mark;
      this.afterCommitFns.length = fnMark;
      return { ok: false, error };
    }
  }

  /**
   * Run `fn` after the current transaction commits (immediately when not in one). While batches
   * are being published, it is queued behind them so it still runs in commit order.
   */
  afterCommit(fn: () => void): void {
    if (this.depth > 0) this.afterCommitFns.push(fn);
    else if (this.publishing) this.outbox.push({ events: [], fns: [fn] });
    else fn();
  }

  private publish(e: EventEnvelope): void {
    this.hub.emit("event", e);
    if (e.type === "task.updated") {
      const task = e.data as Task;
      this.hub.emit("task.changed", { id: task.id, task });
    } else if (e.type === "task.deleted") {
      this.hub.emit("task.changed", { id: (e.data as { id: string }).id, task: null });
    } else if (e.type === "run.updated") {
      this.hub.emit("run.changed", e.data as Run);
    } else if (e.type === "interaction.updated") {
      this.hub.emit("interaction.updated", e.data as Interaction);
    }
  }

  /**
   * Append a durable event with the next global `seq`. Validates `data` against the event's
   * schema. Joins the caller's transaction (or opens one); published after commit.
   */
  appendEvent<T extends EventType>(type: T, scope: EventScope, data: EventData<T>): EventEnvelope {
    const parsed = (EventDataSchemas[type] as { parse(v: unknown): unknown }).parse(data);
    return this.tx(() => {
      const id = newId("evt");
      const at = this.nowIso();
      const r = this.st
        .get(
          "INSERT INTO events (id, type, session_id, task_id, project_id, host_id, json, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          id,
          type,
          scope.sessionId ?? null,
          scope.taskId ?? null,
          scope.projectId ?? null,
          scope.hostId ?? null,
          JSON.stringify(parsed),
          at,
        );
      const env: EventEnvelope = { seq: Number(r.lastInsertRowid), id, type, at, data: parsed };
      if (scope.hostId) env.hostId = scope.hostId;
      if (scope.sessionId) env.sessionId = scope.sessionId;
      if (scope.taskId) env.taskId = scope.taskId;
      if (scope.projectId) env.projectId = scope.projectId;
      this.pending.push(env);
      return env;
    });
  }

  // ---- convenience upsert + event helpers -------------------------------------------------

  putHost(h: Host): Host {
    return this.tx(() => {
      this.hosts.upsert(h);
      this.appendEvent("host.updated", { hostId: h.id }, h);
      return h;
    });
  }

  putDevice(d: Device): Device {
    return this.tx(() => {
      this.devices.upsert(d);
      this.appendEvent("device.updated", {}, d);
      return d;
    });
  }

  putProject(p: Project): Project {
    return this.tx(() => {
      this.projects.upsert(p);
      this.appendEvent("project.updated", { projectId: p.id }, p);
      return p;
    });
  }

  putCheckout(c: Checkout): Checkout {
    return this.tx(() => {
      this.checkouts.upsert(c);
      this.appendEvent("checkout.updated", { projectId: c.projectId, hostId: c.hostId }, c);
      return c;
    });
  }

  putWorkspace(w: Workspace): Workspace {
    return this.tx(() => {
      this.workspaces.upsert(w);
      this.appendEvent("workspace.updated", { projectId: w.projectId, hostId: w.hostId }, w);
      return w;
    });
  }

  removeWorkspace(w: Workspace): void {
    this.tx(() => {
      this.workspaces.delete(w.id);
      this.appendEvent(
        "workspace.removed",
        { projectId: w.projectId, hostId: w.hostId },
        {
          id: w.id,
        },
      );
    });
  }

  putProfile(p: Profile): Profile {
    return this.tx(() => {
      this.profiles.upsert(p);
      this.appendEvent("profile.updated", {}, p);
      return p;
    });
  }

  putSession(s: Session): Session {
    return this.tx(() => {
      this.sessions.upsert(s);
      this.appendEvent(
        "session.updated",
        {
          sessionId: s.id,
          hostId: s.hostId,
          projectId: s.projectId ?? undefined,
          taskId: s.taskId ?? undefined,
        },
        s,
      );
      return s;
    });
  }

  putInteraction(i: Interaction, scope: EventScope = {}): Interaction {
    return this.tx(() => {
      this.interactions.upsert(i);
      this.appendEvent("interaction.updated", { ...scope, sessionId: i.sessionId }, i);
      return i;
    });
  }

  putTask(t: Task): Task {
    return this.tx(() => {
      this.tasks.upsert(t);
      this.appendEvent("task.updated", { taskId: t.id, projectId: t.projectId }, t);
      return t;
    });
  }

  deleteTask(t: Task): void {
    this.tx(() => {
      this.tasks.delete(t.id);
      this.appendEvent("task.deleted", { taskId: t.id, projectId: t.projectId }, { id: t.id });
    });
  }

  putRun(r: Run, projectId?: string): Run {
    return this.tx(() => {
      this.runs.upsert(r);
      this.appendEvent(
        "run.updated",
        { taskId: r.taskId, sessionId: r.sessionId ?? undefined, projectId },
        r,
      );
      return r;
    });
  }

  putAutomation(a: Automation, extra?: Record<string, SqlValue>): Automation {
    return this.tx(() => {
      this.automations.upsert(a, extra);
      this.appendEvent("automation.updated", { projectId: a.projectId }, a);
      return a;
    });
  }

  putAttention(a: AttentionItem): AttentionItem {
    return this.tx(() => {
      this.attention.upsert(a);
      this.appendEvent(
        "attention.updated",
        {
          sessionId: a.sessionId ?? undefined,
          taskId: a.taskId ?? undefined,
          projectId: a.projectId ?? undefined,
        },
        a,
      );
      return a;
    });
  }

  /** Insert an occurrence unless `(automationId, key)` exists. Returns false on duplicate. */
  insertOccurrence(o: Occurrence): boolean {
    return this.tx(() => {
      const r = this.st
        .get(
          "INSERT OR IGNORE INTO occurrences (id, json, automation_id, state, task_id, key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(o.id, JSON.stringify(o), o.automationId, o.state, o.taskId, o.key, o.createdAt);
      if (Number(r.changes) === 0) return false;
      this.appendEvent("occurrence.created", {}, o);
      return true;
    });
  }

  // ---- lookups ---------------------------------------------------------------------------

  workspaceByPath(hostId: string, path: string): Workspace | undefined {
    return this.workspaces.list("host_id = ? AND path = ?", [hostId, path])[0];
  }

  sessionByNativeFile(hostId: string, sessionFile: string): Session | undefined {
    return this.sessions.list("host_id = ? AND native_session_file = ?", [hostId, sessionFile])[0];
  }

  /** The run controlling a session: `session.runId`, else the newest active run for it. */
  runForSession(session: Session): Run | undefined {
    if (session.runId) {
      const r = this.runs.get(session.runId);
      if (r) return r;
    }
    return this.runs.list(
      `session_id = ? AND state IN (${ACTIVE_RUN_STATES.map(() => "?").join(",")})`,
      [session.id, ...ACTIVE_RUN_STATES],
      "created_at DESC",
    )[0];
  }

  activeRunsOnHost(hostId: string): Run[] {
    return this.runs.list(
      `host_id = ? AND state IN (${ACTIVE_RUN_STATES.map(() => "?").join(",")})`,
      [hostId, ...ACTIVE_RUN_STATES],
    );
  }

  // ---- transcript items ------------------------------------------------------------------

  upsertItem(item: TranscriptItem): void {
    this.st
      .get(
        "INSERT INTO session_items (session_id, item_id, ord, json) VALUES (?, ?, ?, ?) ON CONFLICT(session_id, item_id) DO UPDATE SET ord = excluded.ord, json = excluded.json",
      )
      .run(item.sessionId, item.id, item.order, JSON.stringify(item));
  }

  /** Replace a session's whole transcript (read-only views re-read from the native file). */
  replaceItems(sessionId: string, items: TranscriptItem[]): void {
    this.st.get("DELETE FROM session_items WHERE session_id = ?").run(sessionId);
    for (const item of items) this.upsertItem(item);
  }

  /** Items in ascending order; `before` pages backwards from an order value. */
  listItems(
    sessionId: string,
    opts: { before?: number; limit?: number } = {},
  ): { items: TranscriptItem[]; hasMore: boolean } {
    const limit = Math.max(1, Math.min(opts.limit ?? 200, 1000));
    const rows = (
      opts.before === undefined
        ? this.st
            .get("SELECT json FROM session_items WHERE session_id = ? ORDER BY ord DESC LIMIT ?")
            .all(sessionId, limit + 1)
        : this.st
            .get(
              "SELECT json FROM session_items WHERE session_id = ? AND ord < ? ORDER BY ord DESC LIMIT ?",
            )
            .all(sessionId, opts.before, limit + 1)
    ) as { json: string }[];
    const hasMore = rows.length > limit;
    const items = rows
      .slice(0, limit)
      .reverse()
      .map((r) => JSON.parse(r.json) as TranscriptItem);
    return { items, hasMore };
  }

  maxItemOrder(sessionId: string): number {
    const r = this.st
      .get("SELECT MAX(ord) AS m FROM session_items WHERE session_id = ?")
      .get(sessionId) as { m: number | null };
    return r.m ?? -1;
  }

  // ---- panels and adapters ---------------------------------------------------------------

  upsertPanel(p: Panel): void {
    this.st
      .get(
        "INSERT INTO panels (session_id, adapter_id, slot, json) VALUES (?, ?, ?, ?) ON CONFLICT(session_id, adapter_id, slot) DO UPDATE SET json = excluded.json",
      )
      .run(p.sessionId, p.adapterId, p.slot, JSON.stringify(p));
  }

  deletePanel(sessionId: string, adapterId: string, slot: string): void {
    this.st
      .get("DELETE FROM panels WHERE session_id = ? AND adapter_id = ? AND slot = ?")
      .run(sessionId, adapterId, slot);
  }

  listPanels(sessionId?: string): Panel[] {
    const rows = (
      sessionId
        ? this.st.get("SELECT json FROM panels WHERE session_id = ?").all(sessionId)
        : this.st.get("SELECT json FROM panels").all()
    ) as { json: string }[];
    return rows.map((r) => JSON.parse(r.json) as Panel);
  }

  setHostAdapters(hostId: string, adapters: AdapterInfo[]): void {
    this.st
      .get(
        "INSERT INTO host_adapters (host_id, json, updated_at) VALUES (?, ?, ?) ON CONFLICT(host_id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at",
      )
      .run(hostId, JSON.stringify(adapters), this.nowIso());
  }

  adaptersByHost(): Record<string, AdapterInfo[]> {
    const out: Record<string, AdapterInfo[]> = {};
    for (const r of this.st.get("SELECT host_id, json FROM host_adapters").all() as {
      host_id: string;
      json: string;
    }[]) {
      out[r.host_id] = JSON.parse(r.json) as AdapterInfo[];
    }
    return out;
  }

  setRenderer(hostId: string, adapterId: string, html: string | null): void {
    if (html === null) {
      this.st
        .get("DELETE FROM adapter_renderers WHERE host_id = ? AND adapter_id = ?")
        .run(hostId, adapterId);
      return;
    }
    this.st
      .get(
        "INSERT INTO adapter_renderers (host_id, adapter_id, html, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(host_id, adapter_id) DO UPDATE SET html = excluded.html, updated_at = excluded.updated_at",
      )
      .run(hostId, adapterId, html, this.nowIso());
  }

  getRenderer(hostId: string | null, adapterId: string): string | undefined {
    const row = (
      hostId
        ? this.st
            .get("SELECT html FROM adapter_renderers WHERE host_id = ? AND adapter_id = ?")
            .get(hostId, adapterId)
        : this.st
            .get(
              "SELECT html FROM adapter_renderers WHERE adapter_id = ? ORDER BY updated_at DESC LIMIT 1",
            )
            .get(adapterId)
    ) as { html: string } | undefined;
    return row?.html;
  }

  // ---- enrollments and credentials -------------------------------------------------------

  insertEnrollment(row: EnrollmentRow): void {
    this.st
      .get(
        "INSERT INTO enrollments (id, kind, token_hash, expires_at, used_at, result_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        row.id,
        row.kind,
        row.token_hash,
        row.expires_at,
        row.used_at,
        row.result_id,
        row.created_by,
        row.created_at,
      );
  }

  enrollmentByHash(hash: string): EnrollmentRow | undefined {
    return this.st.get("SELECT * FROM enrollments WHERE token_hash = ?").get(hash) as
      | EnrollmentRow
      | undefined;
  }

  /** Atomically mark an enrollment used. False when it was already used. */
  markEnrollmentUsed(id: string, resultId: string): boolean {
    const r = this.st
      .get("UPDATE enrollments SET used_at = ?, result_id = ? WHERE id = ? AND used_at IS NULL")
      .run(this.nowIso(), resultId, id);
    return Number(r.changes) === 1;
  }

  deviceByCredentialHash(hash: string): (Device & { isAdmin: boolean }) | undefined {
    const row = this.st
      .get("SELECT json, is_admin FROM devices WHERE credential_hash = ?")
      .get(hash) as { json: string; is_admin: number } | undefined;
    return row ? { ...(JSON.parse(row.json) as Device), isAdmin: row.is_admin === 1 } : undefined;
  }

  hostCredentialHash(hostId: string): string | undefined {
    const row = this.st.get("SELECT credential_hash FROM hosts WHERE id = ?").get(hostId) as
      | { credential_hash: string }
      | undefined;
    return row?.credential_hash;
  }

  // ---- host link bookkeeping -------------------------------------------------------------

  ackedHostSeq(hostId: string): number {
    const row = this.st.get("SELECT acked_host_seq FROM hosts WHERE id = ?").get(hostId) as
      | { acked_host_seq: number }
      | undefined;
    return row?.acked_host_seq ?? 0;
  }

  setAckedHostSeq(hostId: string, hostSeq: number): void {
    this.st
      .get("UPDATE hosts SET acked_host_seq = MAX(acked_host_seq, ?) WHERE id = ?")
      .run(hostSeq, hostId);
  }

  hasSeenHostEvent(hostId: string, eventId: string): boolean {
    return !!this.st
      .get("SELECT 1 FROM host_events_seen WHERE host_id = ? AND event_id = ?")
      .get(hostId, eventId);
  }

  markHostEventSeen(hostId: string, eventId: string): void {
    this.st
      .get("INSERT OR IGNORE INTO host_events_seen (host_id, event_id, seen_at) VALUES (?, ?, ?)")
      .run(hostId, eventId, this.nowIso());
  }

  // ---- presence, push, notifications -----------------------------------------------------

  upsertPresence(p: PresenceRow): void {
    this.st
      .get(
        "INSERT INTO presence (device_id, foreground_until, interacted_at, viewing_session_id, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(device_id) DO UPDATE SET foreground_until = excluded.foreground_until, interacted_at = excluded.interacted_at, viewing_session_id = excluded.viewing_session_id, updated_at = excluded.updated_at",
      )
      .run(p.deviceId, p.foregroundUntil, p.interactedAt, p.viewingSessionId, p.updatedAt);
  }

  private presenceFromRow(r: Record<string, unknown>): PresenceRow {
    return {
      deviceId: r.device_id as string,
      foregroundUntil: (r.foreground_until as string | null) ?? null,
      interactedAt: (r.interacted_at as string | null) ?? null,
      viewingSessionId: (r.viewing_session_id as string | null) ?? null,
      updatedAt: r.updated_at as string,
    };
  }

  getPresence(deviceId: string): PresenceRow | undefined {
    const r = this.st.get("SELECT * FROM presence WHERE device_id = ?").get(deviceId) as
      | Record<string, unknown>
      | undefined;
    return r ? this.presenceFromRow(r) : undefined;
  }

  listPresence(): PresenceRow[] {
    return (this.st.get("SELECT * FROM presence").all() as Record<string, unknown>[]).map((r) =>
      this.presenceFromRow(r),
    );
  }

  upsertPushSubscription(row: PushSubscriptionRow): void {
    this.st
      .get(
        "INSERT INTO push_subscriptions (device_id, endpoint, json, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET device_id = excluded.device_id, json = excluded.json",
      )
      .run(row.deviceId, row.endpoint, JSON.stringify(row.subscription), row.createdAt);
  }

  deletePushSubscription(endpoint: string): void {
    this.st.get("DELETE FROM push_subscriptions WHERE endpoint = ?").run(endpoint);
  }

  deletePushSubscriptionsForDevice(deviceId: string): void {
    this.st.get("DELETE FROM push_subscriptions WHERE device_id = ?").run(deviceId);
  }

  listPushSubscriptions(deviceId?: string): PushSubscriptionRow[] {
    const rows = (
      deviceId
        ? this.st.get("SELECT * FROM push_subscriptions WHERE device_id = ?").all(deviceId)
        : this.st.get("SELECT * FROM push_subscriptions").all()
    ) as { device_id: string; endpoint: string; json: string; created_at: string }[];
    return rows.map((r) => ({
      deviceId: r.device_id,
      endpoint: r.endpoint,
      subscription: JSON.parse(r.json),
      createdAt: r.created_at,
    }));
  }

  getNotification(sessionId: string): NotificationRow | undefined {
    const r = this.st.get("SELECT * FROM notifications WHERE session_id = ?").get(sessionId) as
      | Record<string, string | null>
      | undefined;
    return r
      ? {
          sessionId: r.session_id!,
          attentionId: r.attention_id ?? null,
          sentToDevice: r.sent_to_device ?? null,
          sentAt: r.sent_at ?? null,
          tag: r.tag ?? null,
        }
      : undefined;
  }

  putNotification(n: NotificationRow): void {
    this.st
      .get(
        "INSERT INTO notifications (session_id, attention_id, sent_to_device, sent_at, tag) VALUES (?, ?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET attention_id = excluded.attention_id, sent_to_device = excluded.sent_to_device, sent_at = excluded.sent_at, tag = excluded.tag",
      )
      .run(n.sessionId, n.attentionId, n.sentToDevice, n.sentAt, n.tag);
  }

  deleteNotification(sessionId: string): void {
    this.st.get("DELETE FROM notifications WHERE session_id = ?").run(sessionId);
  }

  // ---- settings --------------------------------------------------------------------------

  getSetting<T>(key: string, fallback: T): T {
    const r = this.st.get("SELECT value FROM settings WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return r ? (JSON.parse(r.value) as T) : fallback;
  }

  setSetting(key: string, value: unknown): void {
    this.st
      .get(
        "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, JSON.stringify(value));
  }

  deleteSetting(key: string): void {
    this.st.get("DELETE FROM settings WHERE key = ?").run(key);
  }

  /** Count a settle (running -> idle) of a run's session; recorded with the projection. */
  noteRunSettle(runId: string): number {
    const n = this.runSettleCount(runId) + 1;
    this.setSetting(`runSettles:${runId}`, n);
    return n;
  }

  runSettleCount(runId: string): number {
    return this.getSetting(`runSettles:${runId}`, 0);
  }

  get dispatchPaused(): boolean {
    return this.getSetting("dispatchPaused", false);
  }

  setDispatchPaused(paused: boolean): void {
    this.tx(() => {
      this.setSetting("dispatchPaused", paused);
      this.appendEvent("settings.updated", {}, { dispatchPaused: paused });
    });
  }

  // ---- event log -------------------------------------------------------------------------

  /** Highest seq ever assigned (survives retention deletes). */
  currentSeq(): number {
    const r = this.st.get("SELECT seq FROM sqlite_sequence WHERE name = 'events'").get() as
      | { seq: number }
      | undefined;
    return r?.seq ?? 0;
  }

  /** Clients with `cursor >= minRetainedSeq` can replay; older cursors get a snapshot. */
  minRetainedSeq(): number {
    return this.getSetting("minRetainedSeq", 0);
  }

  eventsAfter(cursor: number, limit = 10000): EventEnvelope[] {
    const rows = this.st
      .get(
        "SELECT seq, id, type, session_id, task_id, project_id, host_id, json, at FROM events WHERE seq > ? ORDER BY seq LIMIT ?",
      )
      .all(cursor, limit) as Record<string, unknown>[];
    return rows.map((r) => this.envelopeFromRow(r));
  }

  latestEvents(type: EventType, limit: number): EventEnvelope[] {
    const rows = this.st
      .get(
        "SELECT seq, id, type, session_id, task_id, project_id, host_id, json, at FROM events WHERE type = ? ORDER BY seq DESC LIMIT ?",
      )
      .all(type, limit) as Record<string, unknown>[];
    return rows.map((r) => this.envelopeFromRow(r));
  }

  private envelopeFromRow(r: Record<string, unknown>): EventEnvelope {
    const env: EventEnvelope = {
      seq: r.seq as number,
      id: r.id as string,
      type: r.type as EventType,
      at: r.at as string,
      data: JSON.parse(r.json as string),
    };
    if (r.host_id) env.hostId = r.host_id as string;
    if (r.session_id) env.sessionId = r.session_id as string;
    if (r.task_id) env.taskId = r.task_id as string;
    if (r.project_id) env.projectId = r.project_id as string;
    return env;
  }

  eventSeqRange(): { min: number | null; max: number | null } {
    const r = this.st.get("SELECT MIN(seq) AS min, MAX(seq) AS max FROM events").get() as {
      min: number | null;
      max: number | null;
    };
    return r;
  }

  get retentionDays(): number {
    return this.getSetting("retentionDays", 30);
  }

  /**
   * Delete events (and host dedupe rows) older than `retentionDays`. Records `minRetainedSeq`
   * as the highest deleted seq, so a client cursor below it gets a snapshot.
   */
  runRetention(): { deleted: number; minRetainedSeq: number } {
    return this.tx(() => {
      const cutoff = new Date(this.now().getTime() - this.retentionDays * 86_400_000).toISOString();
      const r = this.st.get("SELECT MAX(seq) AS m FROM events WHERE at < ?").get(cutoff) as {
        m: number | null;
      };
      let deleted = 0;
      let min = this.minRetainedSeq();
      if (r.m !== null) {
        deleted = Number(this.st.get("DELETE FROM events WHERE seq <= ?").run(r.m).changes);
        min = Math.max(min, r.m);
        this.setSetting("minRetainedSeq", min);
      }
      this.st.get("DELETE FROM host_events_seen WHERE seen_at < ?").run(cutoff);
      return { deleted, minRetainedSeq: min };
    });
  }

  // ---- snapshot --------------------------------------------------------------------------

  /** Server-authoritative state for a client snapshot (transcripts are loaded per session). */
  syncState(): SyncState {
    const tasks = this.tasks.list(undefined, [], "created_at");
    const sessions = this.sessions.list("archived_at IS NULL", [], "last_activity_at DESC");
    const runIds = new Set<string>();
    for (const t of tasks) if (t.currentRunId) runIds.add(t.currentRunId);
    for (const s of sessions) if (s.runId) runIds.add(s.runId);
    const runs = this.runs
      .list(undefined, [], "created_at")
      .filter((r) => runIds.has(r.id) || ACTIVE_RUN_STATES.includes(r.state));
    return {
      hosts: this.hosts.list(undefined, [], "created_at"),
      projects: this.projects.list(undefined, [], "created_at"),
      checkouts: this.checkouts.list(),
      workspaces: this.workspaces.list("archived_at IS NULL"),
      profiles: this.profiles.list(undefined, [], "created_at, rowid"),
      sessions,
      tasks,
      runs,
      automations: this.automations.list(undefined, [], "created_at"),
      attention: this.attention.list("resolved_at IS NULL", [], "created_at"),
      interactions: this.interactions.list("state IN ('pending', 'unsupported')", [], "created_at"),
      panels: this.listPanels(),
      devices: this.devices.list("is_admin = 0", [], "created_at"),
      adapters: this.adaptersByHost(),
      dispatchPaused: this.dispatchPaused,
    };
  }
}

export { ACTIVE_RUN_STATES };
