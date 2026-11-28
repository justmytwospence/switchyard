import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type Db, LATEST_MIGRATION, MIGRATIONS, migrate, openDb } from "../src/db/index.js";

/** A database migrated to `version`, as an older coordinator would have left it. */
function dbAt(version: number): Db {
  const db = openDb(":memory:");
  db.exec(
    "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)",
  );
  for (const m of MIGRATIONS.filter((x) => x.version <= version)) {
    db.exec(m.sql);
    db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
      m.version,
      m.name,
      "2026-01-01T00:00:00.000Z",
    );
  }
  return db;
}

/** Apply the pending migrations up to `version` only: what that release's coordinator would do. */
function upTo(db: Db, version: number): void {
  const row = db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number };
  for (const m of MIGRATIONS.filter((x) => x.version > (row.v ?? 0) && x.version <= version)) {
    db.exec(m.sql);
    db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
      m.version,
      m.name,
      "2026-01-01T00:00:00.000Z",
    );
  }
}

describe("coordinator migrations", () => {
  it("024 creates sparse issue work keyed by project and node, allowing shared branches", () => {
    const db = dbAt(23);
    expect(migrate(db)).toBe(24);
    const insert = db.prepare(`INSERT INTO issue_work
      (project_id, github_issue_node_id, number, url, title, branch, workspace_id, pending_session_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    insert.run(
      "project",
      "node1",
      1,
      "https://github.com/a/b/issues/1",
      "One",
      "shared",
      null,
      null,
    );
    insert.run(
      "project",
      "node2",
      2,
      "https://github.com/a/b/issues/2",
      "Two",
      "shared",
      null,
      null,
    );
    insert.run("other", "node1", 1, "https://github.com/a/b/issues/1", "One", "shared", null, null);
    expect(() => insert.run("project", "node1", 1, "url", "One", "other", null, null)).toThrow();
    expect(db.prepare("SELECT count(*) AS n FROM issue_work").get()).toEqual({
      n: 3,
    });
    db.close();
  });

  it("023 merges views and trackers into scopes, renames terminals to clients and forces a snapshot", () => {
    const db = dbAt(22);
    const ins = (table: string, cols: string[], row: unknown[]) =>
      db
        .prepare(
          `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
        )
        .run(...(row as string[]));
    const view = (id: string, name: string, extra: Record<string, unknown> = {}) =>
      ins(
        "views",
        ["id", "name", "json", "created_at"],
        [
          id,
          name,
          JSON.stringify({
            id,
            name,
            mode: "all",
            projectIds: null,
            hostIds: null,
            sessionIds: [],
            clients: [],
            createdAt: "2026-01-01",
            updatedAt: "2026-01-02",
            ...extra,
          }),
          "2026-01-01",
        ],
      );
    const tracker = (id: string, name: string, extra: Record<string, unknown> = {}) =>
      ins(
        "trackers",
        ["id", "name", "json", "created_at"],
        [
          id,
          name,
          JSON.stringify({
            id,
            name,
            provider: "github",
            hostId: "hst_1",
            owner: "acme",
            repositories: null,
            extraRepositories: [],
            board: null,
            follow: "assigned",
            writeBack: true,
            moveShared: true,
            enabled: true,
            login: "me",
            lastSyncedAt: "2026-02-01",
            lastError: null,
            createdAt: "2026-01-03",
            updatedAt: "2026-02-01",
            ...extra,
          }),
          "2026-01-03",
        ],
      );
    // A view no tracker keeps (pinned-only), and one whose tracker is long gone.
    view("viw_manual", "scratch", { mode: "pinned", sessionIds: ["ses_1"] });
    view("viw_stale", "clients", { trackerId: "trk_gone" });
    // A tracker with its view.
    view("viw_work", "work", {
      trackerId: "trk_work",
      projectIds: ["prj_1"],
      sessionIds: ["ses_2"],
    });
    tracker("trk_work", "work");
    // A tracker that never synced adopts the view of its name, as its first sync would have.
    view("viw_personal", "Personal");
    tracker("trk_personal", "personal", { login: null, lastSyncedAt: null });
    // A tracker whose view was renamed, and one with no view whose name that view took.
    view("viw_dup", "dup", { trackerId: "trk_renamed" });
    tracker("trk_renamed", "renamed");
    tracker("trk_orphan01", "dup");
    const issue = (id: string, trackerId: string) =>
      ins(
        "tracked_issues",
        ["id", "tracker_id", "project_id", "json", "created_at"],
        [id, trackerId, "prj_1", JSON.stringify({ id, trackerId, itemId: "I_1" }), "2026-01-05"],
      );
    issue("trk_work:I_1", "trk_work");
    issue("trk_dead:I_9", "trk_dead");
    const terminal = (id: string, viewId: string | null, json: Record<string, unknown>) =>
      ins(
        "terminals",
        ["id", "device_id", "view_id", "last_seen_at", "json", "created_at"],
        [id, "dev_1", viewId, "2026-03-01", JSON.stringify({ id, viewId, ...json }), "2026-01-01"],
      );
    terminal("herdr:work@mac", "viw_work", { mirror: "view", shows: ["ses_2"] });
    terminal("herdr:all@mac", null, { mirror: "all" });
    terminal("herdr:none@mac", null, { mirror: "none" });
    terminal("tmux:scratch@mac", "viw_manual", { mirror: "view" });
    terminal("tmux:old@mac", "viw_manual", {}); // written before `mirror` existed
    terminal("tmux:gone@mac", "viw_deleted", { mirror: "view" });
    ins(
      "presence",
      ["device_id", "terminal_id", "updated_at"],
      ["dev_1", "herdr:work@mac", "2026"],
    );
    const ev = db.prepare("INSERT INTO events (id, type, json, at) VALUES (?, ?, ?, ?)");
    for (const type of ["view.updated", "session.updated", "terminal.updated"])
      ev.run(`evt_${type}`, type, "{}", "2026");
    ins("settings", ["key", "value"], ["minRetainedSeq", "1"]);

    migrate(db);

    const scopes = (
      db.prepare("SELECT id, name, json FROM scopes ORDER BY id").all() as {
        id: string;
        name: string;
        json: string;
      }[]
    ).map((r) => ({ row: r.name, ...JSON.parse(r.json) }));
    const scope = (id: string) => scopes.find((s) => s.id === id);
    expect(scopes.map((s) => s.id)).toEqual([
      "trk_orphan01",
      "trk_personal",
      "trk_renamed",
      "trk_work",
      "viw_manual",
      "viw_stale",
    ]);
    for (const s of scopes) expect(s.row).toBe(s.name);
    expect(scope("viw_manual")).toMatchObject({
      name: "scratch",
      mode: "pinned",
      sessionIds: ["ses_1"],
      source: null,
    });
    expect(scope("viw_stale")).toMatchObject({ name: "clients", source: null });
    for (const s of scopes) {
      expect("clients" in s).toBe(false);
      expect("trackerId" in s).toBe(false);
    }
    expect(scope("trk_work")).toMatchObject({
      name: "work",
      projectIds: ["prj_1"],
      sessionIds: ["ses_2"],
      createdAt: "2026-01-01",
      source: { kind: "github", owner: "acme", hostId: "hst_1", login: "me", writeBack: true },
    });
    const source = scope("trk_work").source;
    for (const key of ["id", "name", "provider", "createdAt", "updatedAt"])
      expect(key in source).toBe(false);
    expect(scope("trk_personal")).toMatchObject({ name: "Personal", source: { login: null } });
    expect(scope("trk_renamed")).toMatchObject({ name: "dup", source: { kind: "github" } });
    expect(scope("trk_orphan01")).toMatchObject({
      name: "dup orphan01",
      mode: "all",
      projectIds: [],
      hostIds: null,
      sessionIds: [],
      source: { kind: "github" },
    });

    const clients = Object.fromEntries(
      (
        db.prepare("SELECT id, scope_id, json FROM clients").all() as {
          id: string;
          scope_id: string | null;
          json: string;
        }[]
      ).map((r) => [r.id, { column: r.scope_id, ...JSON.parse(r.json) }]),
    );
    expect(clients["herdr:work@mac"]).toMatchObject({
      column: "trk_work",
      scopeId: "trk_work",
      mirror: "scope",
      shows: ["ses_2"],
    });
    expect(clients["herdr:all@mac"]).toMatchObject({ scopeId: null, mirror: "all" });
    expect(clients["herdr:none@mac"]).toMatchObject({ scopeId: null, mirror: "none" });
    expect(clients["tmux:scratch@mac"]).toMatchObject({ scopeId: "viw_manual", mirror: "scope" });
    expect(clients["tmux:old@mac"]).toMatchObject({ scopeId: "viw_manual", mirror: "scope" });
    expect(clients["tmux:gone@mac"]).toMatchObject({ column: null, scopeId: null, mirror: "none" });
    for (const c of Object.values(clients)) expect("viewId" in c).toBe(false);

    const issues = db.prepare("SELECT id, scope_id, json FROM tracked_issues").all() as {
      id: string;
      scope_id: string;
      json: string;
    }[];
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ id: "trk_work:I_1", scope_id: "trk_work" });
    expect(JSON.parse(issues[0]!.json)).toMatchObject({
      scopeId: "trk_work",
      trackerId: "trk_work",
    });

    expect(db.prepare("SELECT client_id FROM presence").all()).toEqual([
      { client_id: "herdr:work@mac" },
    ]);
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
    ).map((r) => r.name);
    expect(tables).not.toContain("views");
    expect(tables).not.toContain("trackers");
    expect(tables).not.toContain("terminals");
    // Every cursor is behind it: all clients take a snapshot, and old events are never replayed.
    expect(db.prepare("SELECT value FROM settings WHERE key = 'minRetainedSeq'").get()).toEqual({
      value: "4",
    });
    db.close();
  });

  it("022 keys presence by device and terminal", () => {
    const db = dbAt(21);
    db.prepare(
      "INSERT INTO presence (device_id, foreground_until, interacted_at, viewing_session_id, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run("dev_1", null, null, null, "2026");
    upTo(db, 22);
    const put = db.prepare(
      "INSERT INTO presence (device_id, terminal_id, updated_at) VALUES (?, ?, ?)",
    );
    put.run("dev_1", "", "2026");
    put.run("dev_1", "herdr:a@m", "2026");
    expect(() => put.run("dev_1", "herdr:a@m", "2026")).toThrow();
    db.close();
  });

  it("021 turns surfaces into terminals with a recorded binding", () => {
    const db = dbAt(20);
    const put = db.prepare(
      "INSERT INTO surfaces (id, device_id, view_id, last_seen_at, json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    );
    put.run(
      "herdr:a@m",
      "dev_1",
      "viw_1",
      "2026-02",
      JSON.stringify({ id: "herdr:a@m", viewId: "viw_1" }),
      "2026",
    );
    put.run(
      "tmux:b@m",
      "dev_1",
      null,
      "2026-03",
      JSON.stringify({ id: "tmux:b@m", viewId: null }),
      "2026",
    );
    const ev = db.prepare("INSERT INTO events (id, type, json, at) VALUES (?, ?, ?, ?)");
    ev.run("evt_1", "surface.updated", "{}", "2026");
    ev.run("evt_2", "surface.deleted", "{}", "2026");
    upTo(db, 21);
    const json = (id: string) =>
      JSON.parse(
        (db.prepare("SELECT json FROM terminals WHERE id = ?").get(id) as { json: string }).json,
      );
    expect(json("herdr:a@m")).toMatchObject({
      mirror: "view",
      viewId: "viw_1",
      bindingSetAt: "2026-02",
      shows: [],
    });
    expect(json("tmux:b@m")).toMatchObject({ mirror: "none", bindingSetAt: null, shows: [] });
    const types = (
      db.prepare("SELECT type FROM events ORDER BY seq").all() as { type: string }[]
    ).map((r) => r.type);
    expect(types).toEqual(["terminal.updated", "terminal.deleted"]);
    db.close();
  });

  it("020 removes view sources and startedIn, keeping pins", () => {
    const db = dbAt(19);
    const view = db.prepare("INSERT INTO views (id, name, json, created_at) VALUES (?, ?, ?, ?)");
    view.run(
      "viw_1",
      "daily",
      JSON.stringify({
        id: "viw_1",
        mode: "pinned",
        sessionIds: ["ses_1"],
        clientId: "herdr:default@mac",
      }),
      "2026",
    );
    view.run("viw_2", "other", JSON.stringify({ id: "viw_2", clientId: null }), "2026");
    db.prepare(
      "INSERT INTO sessions (id, host_id, runtime, last_activity_at, json) VALUES (?, ?, ?, ?, ?)",
    ).run(
      "ses_1",
      "hst_1",
      "idle",
      "2026",
      JSON.stringify({
        id: "ses_1",
        startedIn: "herdr:default@mac",
        external: { client: "herdr:default@mac" },
      }),
    );
    upTo(db, 20);
    const json = (table: "views" | "sessions", id: string) =>
      JSON.parse(
        (db.prepare(`SELECT json FROM ${table} WHERE id = ?`).get(id) as { json: string }).json,
      );
    expect(json("views", "viw_1")).toEqual({
      id: "viw_1",
      mode: "pinned",
      sessionIds: ["ses_1"],
    });
    expect("clientId" in json("views", "viw_2")).toBe(false);
    expect(json("sessions", "ses_1")).toEqual({
      id: "ses_1",
      external: { client: "herdr:default@mac" },
    });
    db.close();
  });

  it("017 adds surfaces and empties view clients", () => {
    const db = dbAt(16);
    db.prepare("INSERT INTO views (id, name, json, created_at) VALUES (?, ?, ?, ?)").run(
      "viw_1",
      "work",
      JSON.stringify({ id: "viw_1", clients: [{ id: "herdr:a@m" }] }),
      "2026",
    );
    upTo(db, 17);
    const json = JSON.parse(
      (db.prepare("SELECT json FROM views WHERE id = 'viw_1'").get() as { json: string }).json,
    );
    expect(json.clients).toEqual([]);
    db.prepare(
      "INSERT INTO surfaces (id, device_id, view_id, last_seen_at, json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("herdr:a@m", "dev_1", null, "2026", "{}", "2026");
    db.close();
  });

  it("016 backfills subagent parents", () => {
    const db = dbAt(15);
    const put = db.prepare(
      "INSERT INTO sessions (id, host_id, runtime, last_activity_at, json) VALUES (?, ?, ?, ?, ?)",
    );
    put.run("ses_parent", "hst_1", "idle", "2026", JSON.stringify({ id: "ses_parent" }));
    put.run("ses_sub", "hst_1", "stopped", "2026", JSON.stringify({ id: "ses_sub" }));
    put.run(
      "ses_ext",
      "hst_1",
      "idle",
      "2026",
      JSON.stringify({ id: "ses_ext", external: { client: "herdr:default@mac" } }),
    );
    db.prepare(
      "INSERT INTO session_items (session_id, item_id, ord, json) VALUES (?, ?, ?, ?)",
    ).run(
      "ses_parent",
      "itm_1",
      1,
      JSON.stringify({ kind: "subagent", data: { linkedSessionId: "ses_sub" } }),
    );
    migrate(db);
    const json = (id: string) =>
      JSON.parse(
        (db.prepare("SELECT json FROM sessions WHERE id = ?").get(id) as { json: string }).json,
      );
    expect(json("ses_sub").parentSessionId).toBe("ses_parent");
    expect(json("ses_parent").parentSessionId).toBeUndefined();
    expect(json("ses_ext").startedIn).toBeUndefined();
    db.close();
  });

  it("015 adds tracked_issues and re-keys tracker settings", () => {
    const db = dbAt(14);
    db.prepare(
      "INSERT INTO tasks (id, project_id, state, json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      "tsk_1",
      "prj_1",
      "backlog",
      JSON.stringify({ id: "tsk_1", tracker: { trackerId: "trk_1", itemId: "I_1" } }),
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
    );
    const set = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)");
    set.run("trackerMoved:tsk_1:In progress", '"2026"');
    set.run("trackerBranchTried:tsk_1:12-x", '"2026"');
    upTo(db, 15);
    const keys = (
      db.prepare("SELECT key FROM settings ORDER BY key").all() as { key: string }[]
    ).map((r) => r.key);
    expect(keys).toContain("issueMoved:trk_1:I_1:In progress");
    expect(keys).toContain("issueBranchTried:trk_1:I_1:12-x");
    expect(keys.some((k) => k.startsWith("tracker"))).toBe(false);
    db.prepare(
      "INSERT INTO tracked_issues (id, tracker_id, project_id, json, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run("trk_1:I_1", "trk_1", "prj_1", "{}", "2026-01-01T00:00:00.000Z");
    db.close();
  });

  it("014 adds the trackers table to a version 13 database", () => {
    const db = dbAt(13);
    upTo(db, 14);
    db.prepare("INSERT INTO trackers (id, name, json, created_at) VALUES (?, ?, ?, ?)").run(
      "trk_1",
      "fieldgoal",
      "{}",
      "2026-01-01T00:00:00.000Z",
    );
    expect(() =>
      db
        .prepare("INSERT INTO trackers (id, name, json, created_at) VALUES (?, ?, ?, ?)")
        .run("trk_2", "FieldGoal", "{}", "2026-01-01T00:00:00.000Z"),
    ).toThrow();
    db.close();
  });

  it.each([undefined, 1])(
    "013 is schema-only with legacy snapshots and backfill marker %s",
    (version) => {
      const db = dbAt(12);
      const snapshot = {
        id: "workspace",
        github: {
          repository: "Owner/Repo",
          headRepository: "fork/repo",
          branch: "topic",
          pullRequest: { number: 42, headRefOid: "a".repeat(40) },
          reason: "Merge outcome unknown. Refresh before retrying.",
          attemptedAt: "2026-01-01T00:00:00.000Z",
        },
      };
      const insert = db.prepare(`INSERT INTO workspaces
      (id, project_id, checkout_id, host_id, path, json) VALUES (?, 'project', 'checkout', 'host', ?, ?)`);
      insert.run("workspace", "/repo", JSON.stringify(snapshot));
      insert.run(
        "alias",
        "/alias",
        JSON.stringify({
          ...snapshot,
          id: "alias",
          github: { ...snapshot.github, repository: "owner/repo" },
        }),
      );
      insert.run(
        "corrupt",
        "/corrupt",
        JSON.stringify({
          id: "corrupt",
          github: { reason: snapshot.github.reason, repository: null, pullRequest: null },
        }),
      );
      insert.run("ordinary", "/ordinary", JSON.stringify({ id: "ordinary" }));
      if (version !== undefined)
        db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(
          "githubMergeFenceLegacyBackfillVersion",
          JSON.stringify(version),
        );
      const originals = db.prepare("SELECT * FROM workspaces ORDER BY id").all();
      const settings = db
        .prepare("SELECT * FROM settings WHERE key <> 'minRetainedSeq' ORDER BY key")
        .all();
      const history = db.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
      expect(migrate(db)).toBe(LATEST_MIGRATION);
      expect(db.prepare("SELECT * FROM workspaces ORDER BY id").all()).toEqual(originals);
      expect(
        db.prepare("SELECT * FROM settings WHERE key <> 'minRetainedSeq' ORDER BY key").all(),
      ).toEqual(settings);
      expect(db.prepare("SELECT * FROM github_merge_fences").all()).toEqual([]);
      expect(
        db.prepare("SELECT * FROM schema_migrations WHERE version <= 12 ORDER BY version").all(),
      ).toEqual(history);
      expect(db.prepare("SELECT name FROM schema_migrations WHERE version = 13").get()).toEqual({
        name: "013_github_merge_fences",
      });
      const originalDb = dbAt(12);
      originalDb.exec(
        readFileSync(
          new URL("./fixtures/013_github_merge_fences.original.sql", import.meta.url),
          "utf8",
        ),
      );
      const schema =
        "SELECT type, name, sql FROM sqlite_master WHERE tbl_name = 'github_merge_fences' ORDER BY type, name";
      expect(db.prepare(schema).all()).toEqual(originalDb.prepare(schema).all());
      originalDb.close();
      expect(db.prepare("PRAGMA foreign_key_list(github_merge_fences)").all()).toEqual([]);
      expect(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'github_merge_fences'",
          )
          .all(),
      ).toContainEqual({ name: "github_merge_fences_target" });
      const applied = db.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
      expect(migrate(db)).toBe(LATEST_MIGRATION);
      expect(db.prepare("SELECT * FROM schema_migrations ORDER BY version").all()).toEqual(applied);
      expect(
        db.prepare("SELECT * FROM settings WHERE key <> 'minRetainedSeq' ORDER BY key").all(),
      ).toEqual(settings);
      expect(db.prepare("SELECT * FROM github_merge_fences").all()).toEqual([]);
      db.close();
    },
  );

  it("013 keeps generations increasing after all fences are cleared and validates states/uniqueness", () => {
    const db = dbAt(12);
    migrate(db);
    const insert = db.prepare(`INSERT INTO github_merge_fences
      (fence_key, hostname, pull_request_node_id, repository, pr_number, attempt_id, command_id,
       expected_head_oid, workspace_id, host_id, state, started_at, updated_at)
      VALUES (?, 'github.com', 'node', 'owner/repo', 1, ?, 'command', 'sha', 'workspace', 'host', ?, 'start', 'update')`);
    const first = Number(insert.run("github.com:node", "attempt", "pending").lastInsertRowid);
    expect(() => insert.run("github.com:node", "different", "unknown")).toThrow(/UNIQUE/);
    expect(() => insert.run("different", "attempt", "unknown")).toThrow(/UNIQUE/);
    expect(() => insert.run("different", "different", "invalid")).toThrow(/CHECK/);
    db.exec("DELETE FROM github_merge_fences");
    expect(
      Number(insert.run("github.com:node", "next", "unknown").lastInsertRowid),
    ).toBeGreaterThan(first);
    db.close();
  });

  it("012 adds a nullable wait lease without changing legacy evaluations or indexes", () => {
    const db = dbAt(11);
    db.exec(`INSERT INTO policy_evaluations
      (evaluation_key, request_hash, scope_kind, scope_id, session_id, revisions_json,
       input_json, provisional_updates_json, verdict, decision_id, interaction_id, result_json,
       canceled, cancellation_reason, created_at, updated_at)
      VALUES ('key', 'hash', 'session', 'session', 'session', '{}', '{}', '{}', 'ASK',
       'decision', 'interaction', '{}', 0, NULL, 'created', 'updated')`);
    const row = db.prepare("SELECT * FROM policy_evaluations").get();
    const indexes = db
      .prepare(
        "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'policy_evaluations' ORDER BY name",
      )
      .all();
    const migrations = db.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
    expect(migrate(db)).toBe(MIGRATIONS.at(-1)!.version);
    expect(db.prepare("SELECT * FROM policy_evaluations").get()).toEqual({
      ...row,
      wait_lease_until: null,
    });
    expect(
      db
        .prepare(
          "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'policy_evaluations' ORDER BY name",
        )
        .all(),
    ).toEqual(indexes);
    expect(
      db.prepare("SELECT * FROM schema_migrations WHERE version <= 11 ORDER BY version").all(),
    ).toEqual(migrations);
    db.prepare(
      "UPDATE policy_evaluations SET wait_lease_until = ? WHERE evaluation_key = 'key'",
    ).run("2026-01-01T00:01:00.000Z");
    expect(db.prepare("SELECT wait_lease_until FROM policy_evaluations").get()).toEqual({
      wait_lease_until: "2026-01-01T00:01:00.000Z",
    });
    expect(migrate(db)).toBe(MIGRATIONS.at(-1)!.version);
    db.close();
  });

  it("010 rebuilds nullable completion senders without losing rows, receipts, indexes or sequence high-water", () => {
    const db = dbAt(9);
    const insert = db.prepare(`
      INSERT INTO agent_messages VALUES
      (?, ?, ?, ?, 'recipient', 'reply', 'chain', 2, '{"body":"private"}',
        'steer', 'held', '2026-01-02', '2026-01-01', '2026-01-01', '2026-01-01')`);
    insert.run(7, "ordinary", "message", "sender");
    insert.run(12, "completion", "completion", "child-session");
    insert.run(99, "deleted", "message", "sender");
    db.exec("DELETE FROM agent_messages WHERE seq = 99");
    db.exec(
      "INSERT INTO agent_call_receipts VALUES ('caller', 'native', 'tool', 'inbox.read', 'hash', '{}', '2026-01-01')",
    );
    db.exec("INSERT INTO task_subscriptions VALUES ('child', 'creator', NULL, '2026-01-01')");
    const rows = db.prepare("SELECT * FROM agent_messages ORDER BY seq").all();
    const receipts = db.prepare("SELECT * FROM agent_call_receipts").all();
    const subscriptions = db.prepare("SELECT * FROM task_subscriptions").all();
    migrate(db);
    expect(db.prepare("SELECT * FROM agent_messages ORDER BY seq").all()).toEqual(rows);
    expect(db.prepare("SELECT * FROM agent_call_receipts").all()).toEqual(receipts);
    expect(db.prepare("SELECT * FROM task_subscriptions").all()).toEqual(subscriptions);
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'agent_messages'",
        )
        .all(),
    ).toEqual(
      expect.arrayContaining([
        { name: "agent_messages_pair_time" },
        { name: "agent_messages_recipient_seq" },
      ]),
    );
    const nullable = db.prepare(`
      INSERT INTO agent_messages (id, kind, sender_session_id, recipient_session_id,
        chain_id, depth, body_json, requested_mode, delivery_state, hold_until, created_at, updated_at)
      VALUES (?, ?, ?, 'creator', 'chain', 0, '{}', 'queue', 'pending', '2026-01-02', '2026-01-01', '2026-01-01')`);
    expect(Number(nullable.run("null-completion", "completion", null).lastInsertRowid)).toBe(100);
    expect(() => nullable.run("null-message", "message", null)).toThrow(/CHECK/);
    expect(() => nullable.run("empty-message", "message", "")).toThrow(/CHECK/);
    expect(() => nullable.run("empty-completion", "completion", "")).toThrow(/CHECK/);
    expect(() => nullable.run("unknown", "unknown", "sender")).toThrow(/CHECK/);
    db.close();
  });

  it("010 preserves the sequence high-water even when every message was deleted", () => {
    const db = dbAt(9);
    db.exec(`INSERT INTO agent_messages VALUES
      (50, 'deleted', 'message', 'sender', 'recipient', NULL, 'chain', 0, '{}',
       'queue', 'pending', '2026-01-02', NULL, '2026-01-01', '2026-01-01');
      DELETE FROM agent_messages;`);
    migrate(db);
    expect(
      db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'agent_messages'").get(),
    ).toEqual({ seq: 50 });
    db.close();
  });

  it("010 rolls its entire rebuild back on invalid legacy data", () => {
    const db = dbAt(9);
    db.exec(`INSERT INTO agent_messages VALUES
      (8, 'invalid', 'unknown', 'sender', 'recipient', NULL, 'chain', 0, '{}',
       'queue', 'pending', '2026-01-02', NULL, '2026-01-01', '2026-01-01');`);
    expect(() => migrate(db)).toThrow(/CHECK/);
    expect(db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({
      version: 9,
    });
    expect(db.prepare("SELECT id, seq FROM agent_messages").all()).toEqual([
      { id: "invalid", seq: 8 },
    ]);
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name = 'agent_messages_rebuilt'").all(),
    ).toEqual([]);
    db.close();
  });

  it("009 backfills indexed parents without rewriting legacy task JSON", () => {
    const db = dbAt(8);
    const insert = db.prepare(
      "INSERT INTO tasks (id, project_id, state, json, created_at, updated_at) VALUES (?, 'p', 'backlog', ?, '2026-01-01', '2026-01-01')",
    );
    const legacy = '{"id":"root"}';
    insert.run("root", legacy);
    insert.run("null", '{"id":"null","parentTaskId":null}');
    insert.run("child", '{"id":"child","parentTaskId":"root"}');
    expect(migrate(db)).toBe(MIGRATIONS.at(-1)!.version);
    expect(db.prepare("SELECT parent_task_id, json FROM tasks WHERE id = 'root'").get()).toEqual({
      parent_task_id: null,
      json: legacy,
    });
    expect(db.prepare("SELECT parent_task_id FROM tasks WHERE id = 'null'").get()).toEqual({
      parent_task_id: null,
    });
    expect(db.prepare("SELECT id FROM tasks WHERE parent_task_id = 'root'").all()).toEqual([
      { id: "child" },
    ]);
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all();
    expect(indexes).toEqual(
      expect.arrayContaining([
        { name: "tasks_parent" },
        { name: "agent_messages_pair_time" },
        { name: "agent_messages_recipient_seq" },
      ]),
    );
    db.close();
  });

  it("009 keys receipts by caller/native/tool/method and subscriptions by child/subscriber", () => {
    const db = dbAt(8);
    migrate(db);
    const receipt = db.prepare(
      "INSERT INTO agent_call_receipts VALUES (?, ?, ?, ?, 'hash', '{}', '2026-01-01')",
    );
    receipt.run("caller", "native", "tool", "task.create");
    expect(() => receipt.run("caller", "native", "tool", "task.create")).toThrow(/UNIQUE/);
    receipt.run("other", "native", "tool", "task.create");
    receipt.run("caller", "other", "tool", "task.create");
    receipt.run("caller", "native", "tool", "message.send");
    const subscription = db.prepare(
      "INSERT INTO task_subscriptions VALUES (?, ?, ?, '2026-01-01')",
    );
    subscription.run("child", "creator", null);
    expect(() => subscription.run("child", "creator", "parent")).toThrow(/UNIQUE/);
    subscription.run("child", "other", "parent");
    db.close();
  });

  it("009 assigns immutable increasing inbox cursors independently of retention", () => {
    const db = dbAt(8);
    migrate(db);
    const insert = db.prepare(
      "INSERT INTO agent_messages (id, kind, sender_session_id, recipient_session_id, chain_id, depth, body_json, requested_mode, delivery_state, hold_until, created_at, updated_at) VALUES (?, 'message', 'sender', 'recipient', 'chain', 0, '{}', 'queue', 'pending', '2026-01-01', '2026-01-01', '2026-01-01')",
    );
    expect(Number(insert.run("first").lastInsertRowid)).toBe(1);
    expect(() => insert.run("first")).toThrow(/UNIQUE/);
    db.exec("DELETE FROM agent_messages");
    expect(Number(insert.run("second").lastInsertRowid)).toBe(2);
    db.close();
  });

  it("008 adds the item revision column", () => {
    const db = dbAt(7);
    db.prepare(
      "INSERT INTO session_items (session_id, item_id, ord, json) VALUES ('s','i',0,'{}')",
    ).run();
    expect(migrate(db)).toBe(MIGRATIONS.at(-1)!.version);
    expect(db.prepare("SELECT rev FROM session_items").get()).toEqual({ rev: 0 });
  });

  it("004 rewrites cancelled interactions and their update events", () => {
    const db = dbAt(3);
    db.prepare(
      "INSERT INTO interactions (id, session_id, state, revision, json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("int_1", "ses_1", "cancelled", 2, '{"id":"int_1","state":"cancelled"}', "2026-01-01");
    db.prepare("INSERT INTO events (id, type, json, at) VALUES (?, ?, ?, ?)").run(
      "evt_1",
      "interaction.updated",
      '{"id":"int_1","state":"cancelled"}',
      "2026-01-01",
    );
    expect(migrate(db)).toBe(MIGRATIONS.at(-1)!.version);
    const row = db.prepare("SELECT state, json FROM interactions WHERE id = 'int_1'").get() as {
      state: string;
      json: string;
    };
    expect(row.state).toBe("canceled");
    expect(JSON.parse(row.json).state).toBe("canceled");
    const ev = db.prepare("SELECT json FROM events WHERE id = 'evt_1'").get() as { json: string };
    expect(JSON.parse(ev.json).state).toBe("canceled");
  });

  it("005 renames the workspace.removed event", () => {
    const db = dbAt(4);
    db.prepare("INSERT INTO events (id, type, json, at) VALUES (?, ?, ?, ?)").run(
      "evt_2",
      "workspace.removed",
      '{"id":"wsp_1"}',
      "2026-01-01",
    );
    expect(migrate(db)).toBe(MIGRATIONS.at(-1)!.version);
    const ev = db.prepare("SELECT type FROM events WHERE id = 'evt_2'").get() as { type: string };
    expect(ev.type).toBe("workspace.deleted");
  });

  it("006 archives duplicate native files and makes them unique", () => {
    const db = dbAt(5);
    const insert = (
      id: string,
      file: string | null,
      createdAt: string,
      runtime = "stopped",
      host = "hst_1",
    ) =>
      db
        .prepare(
          "INSERT INTO sessions (id, host_id, runtime, native_session_file, archived_at, last_activity_at, json) VALUES (?, ?, ?, ?, NULL, ?, ?)",
        )
        .run(
          id,
          host,
          runtime,
          file,
          createdAt,
          JSON.stringify({
            id,
            createdAt,
            runtime,
            archivedAt: null,
            nativeHandle: file ? { sessionId: id, sessionFile: file } : null,
          }),
        );
    insert("ses_old", "/s/a.jsonl", "2026-01-01");
    insert("ses_new", "/s/a.jsonl", "2026-01-02");
    insert("ses_b_old", "/s/b.jsonl", "2026-01-01");
    insert("ses_live_new", "/s/b.jsonl", "2026-01-02", "idle");
    insert("ses_n1", null, "2026-01-01");
    insert("ses_n2", null, "2026-01-02");
    insert("ses_other_host", "/s/a.jsonl", "2026-01-03", "stopped", "hst_2");
    expect(migrate(db)).toBe(MIGRATIONS.at(-1)!.version);
    const row = (id: string) =>
      db
        .prepare("SELECT archived_at, native_session_file, json FROM sessions WHERE id = ?")
        .get(id) as {
        archived_at: string | null;
        native_session_file: string | null;
        json: string;
      };
    expect(row("ses_old")).toMatchObject({ archived_at: null, native_session_file: "/s/a.jsonl" });
    const dup = row("ses_new");
    expect(dup.archived_at).not.toBeNull();
    expect(dup.native_session_file).toBeNull();
    expect(JSON.parse(dup.json)).toMatchObject({ nativeHandle: null, archivedAt: dup.archived_at });
    expect(row("ses_live_new")).toMatchObject({
      archived_at: null,
      native_session_file: "/s/b.jsonl",
    });
    expect(row("ses_b_old").archived_at).not.toBeNull();
    expect(row("ses_other_host")).toMatchObject({
      archived_at: null,
      native_session_file: "/s/a.jsonl",
    });
    expect(row("ses_n1")).toMatchObject({ archived_at: null, native_session_file: null });
    expect(row("ses_n2")).toMatchObject({ archived_at: null, native_session_file: null });
    expect(() => insert("ses_dup", "/s/a.jsonl", "2026-02-01")).toThrow(/UNIQUE/);
  });
});
