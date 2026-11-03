/**
 * Starts the real stack for the browser tests: a coordinator serving packages/web/dist, a host
 * agent running real Pi against the mock model (with the fixture extensions), a temp git repo
 * registered as a project, and seed data created through the REST API with the admin token.
 * Nothing is built here: run `pnpm build` first.
 */
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCoordinator, createLogger } from "../../coordinator/dist/index.js";
import { runHostAgent } from "../../host-agent/dist/index.js";
import {
  fixtureExtensionPath,
  type MockScript,
  makePiEnv,
  makeRepo,
  piBin,
  startMockModel,
  when,
} from "../../test-fixtures/dist/index.js";
import { E2E_PORT, E2E_URL, type E2EState } from "./state";

const here = fileURLToPath(new URL(".", import.meta.url));
const webDist = join(here, "..", "dist");

const LONG_TEXT = Array.from(
  { length: 40 },
  (_, i) =>
    `Paragraph ${i + 1} of the long answer. Switchyard keeps the reading position while new events arrive, so this text is long enough to scroll.`,
).join("\n\n");

export const MOCK_SCRIPT: MockScript = [
  {
    when: when.userSays("LONG-TRANSCRIPT"),
    reply: {
      text: "Checking the status first.",
      toolCalls: [{ name: "fixture_status", arguments: {} }],
    },
  },
  { when: when.toolResult("fixture_status"), reply: { text: LONG_TEXT } },
  {
    when: when.userSays("ASK-FRUIT"),
    reply: { toolCalls: [{ name: "fixture_select", arguments: {} }] },
  },
  { when: when.toolResult("fixture_select"), reply: { text: "Thanks for picking a fruit." } },
  {
    when: when.userSays("ASK-TOPPINGS"),
    reply: {
      toolCalls: [
        {
          name: "ask_user_question",
          arguments: {
            questions: [
              {
                question: "Which toppings do you want?",
                header: "Toppings",
                multiSelect: true,
                options: [
                  { label: "Cheese", description: "Melted" },
                  { label: "Olives", description: "Black" },
                  { label: "Basil", description: "Fresh" },
                ],
              },
            ],
          },
        },
      ],
    },
  },
  {
    when: when.toolResult("ask_user_question"),
    reply: (req) => ({ text: `Got your toppings. ${req.lastText}` }),
  },
  {
    when: when.userSays("SLOW-TASK"),
    reply: { toolCalls: [{ name: "fixture_slow", arguments: { ms: 3_600_000 } }] },
  },
  { when: when.toolResult("fixture_slow"), reply: { text: "Slow work finished." } },
  {
    when: (req) => req.lastRole === "user",
    reply: (req) => ({ text: `Received: ${req.lastText.slice(0, 200)}` }),
  },
];

type Json = any;

async function waitFor<T>(
  label: string,
  fn: () => Promise<T | null | undefined | false>,
  timeoutMs = 60_000,
): Promise<T> {
  const end = Date.now() + timeoutMs;
  let last: unknown = null;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) {
      last = err;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`e2e setup: timed out waiting for ${label}${last ? ` (${String(last)})` : ""}`);
}

export default async function globalSetup(): Promise<void> {
  if (!existsSync(join(webDist, "index.html"))) {
    throw new Error(`packages/web/dist is missing; run \`pnpm build\` first (${webDist})`);
  }
  const root = mkdtempSync(join(tmpdir(), "switchyard-e2e-"));
  const logFile = join(root, "coordinator.log");
  const hostLog = join(root, "host.log");
  console.log(`[e2e] temp root ${root} (logs: coordinator.log, host.log)`);

  const mock = await startMockModel(MOCK_SCRIPT);
  const pi = makePiEnv({ mockUrl: mock.url });

  // Repo with uncommitted changes in the main checkout: Changes lists three files.
  const repo = makeRepo();
  writeFileSync(join(repo.path, "README.md"), "# test repo\n\nEdited by the e2e setup.\n");
  mkdirSync(join(repo.path, "src"), { recursive: true });
  const wide = `export const wide = "${"x".repeat(400)}";\n`;
  writeFileSync(
    join(repo.path, "src", "wide.ts"),
    `// A file with a very long line.\n${wide}export const short = 1;\n`,
  );
  mkdirSync(join(repo.path, "docs"), { recursive: true });
  writeFileSync(join(repo.path, "docs", "guide.md"), "# Guide\n\nFirst line.\nSecond line.\n");
  const changedFiles = ["README.md", "docs/guide.md", "src/wide.ts"];

  const coordinator = createCoordinator({
    dataDir: join(root, "coordinator"),
    listen: { host: "127.0.0.1", port: E2E_PORT },
    publicUrl: E2E_URL,
    trustedOrigins: [E2E_URL, `http://localhost:${E2E_PORT}`],
    webDist,
    rateLimits: false,
    // Initialized through /api/admin/init right below.
    setupHint: false,
    logger: createLogger({ level: "info", destination: createWriteStream(logFile) }),
  });
  await coordinator.start();
  const adminToken = coordinator.adminToken;

  const api = async (method: string, path: string, body?: unknown): Promise<Json> => {
    const res = await fetch(`${E2E_URL}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${adminToken}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text}`);
    return json;
  };

  // Set the server up the way `switchyard init` does, so /enroll offers sign-in.
  await api("POST", "/api/admin/init");

  // Host enrollment with the admin token.
  const enrollment = await api("POST", "/api/hosts/enrollments");
  const hostRes = await fetch(`${E2E_URL}/api/hosts/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: enrollment.token, name: "e2e-host", platform: process.platform }),
  });
  if (hostRes.status !== 201) throw new Error(`host enroll failed: ${await hostRes.text()}`);
  const { hostId, credential } = (await hostRes.json()) as { hostId: string; credential: string };

  const hostLogger = createLogger({ level: "info", destination: createWriteStream(hostLog) });
  const agent = await runHostAgent({
    config: { coordinatorUrl: E2E_URL, hostId, credential, name: "e2e-host" },
    stateDir: join(root, "host-state"),
    piBin: piBin(),
    env: pi.env,
    extraExtensions: [fixtureExtensionPath(), join(here, "fixtures", "ask-extension.js")],
    // Core bundles no adapters: the e2e ask-user-question adapter is an owner adapter.
    ownerAdapterDir: join(here, "fixtures", "adapters"),
    handleSignals: false,
    terminalSessions: false,
    backoffMs: [100, 200, 500],
    logger: hostLogger as never,
  });

  let tornDown = false;
  const teardown = async (keep = !!process.env.SY_E2E_KEEP) => {
    if (tornDown) return;
    tornDown = true;
    await agent.stop().catch(() => {});
    await coordinator.stop().catch(() => {});
    await mock.close().catch(() => {});
    if (keep) {
      console.log(`[e2e] kept ${root}`);
      return;
    }
    pi.cleanup();
    repo.cleanup();
    rmSync(root, { recursive: true, force: true });
  };
  (globalThis as { __syE2ETeardown?: () => Promise<void> }).__syE2ETeardown = () => teardown();

  try {
    await waitFor("host connected", async () => {
      const h = await api("GET", `/api/hosts/${hostId}`);
      return (h.host ?? h).connectivity === "connected";
    });

    const project = await api("POST", "/api/projects", {
      hostId,
      path: repo.path,
      name: "Demo project",
      maxConcurrentRuns: 1,
    });
    const workspaceId: string = await waitFor("main workspace", async () => {
      const p = await api("GET", `/api/projects/${project.id}`);
      return p.workspaces?.[0]?.id as string | undefined;
    });

    const newSession = async (title: string, prompt: string) =>
      (
        await api("POST", "/api/sessions", {
          projectId: project.id,
          workspace: { existingId: workspaceId },
          title,
          prompt,
        })
      ).id as string;
    const sessionWhere = (id: string, pred: (s: Json) => boolean, label: string) =>
      waitFor(label, async () => pred(await api("GET", `/api/sessions/${id}`)));

    const long = await newSession(
      "Long transcript session",
      "LONG-TRANSCRIPT please answer at length",
    );
    const question = await newSession("Question session", "ASK-FRUIT please");

    await sessionWhere(
      long,
      (s) => s.runtime === "idle" && !!s.lastAssistantText,
      "long session idle",
    );
    await waitFor("pending fixture_select", async () => {
      const list = await api("GET", `/api/interactions?sessionId=${question}`);
      const items: Json[] = Array.isArray(list) ? list : (list.items ?? []);
      return items.some((i) => i.state === "pending");
    });

    // Tasks in every column. maxConcurrentRuns 1 keeps later Ready tasks queued.
    const task = (body: Json) => api("POST", "/api/tasks", { projectId: project.id, ...body });
    const taskWhere = (id: string, pred: (t: Json) => boolean, label: string) =>
      waitFor(
        label,
        async () => {
          const t = await api("GET", `/api/tasks/${id}`);
          return pred(t) ? t : null;
        },
        90_000,
      );

    const review = await task({
      title: "Review the greeting copy",
      objective: "Write a short greeting.",
      acceptanceCriteria: ["The greeting is friendly"],
      state: "ready",
    });
    const reviewed = await taskWhere(review.id, (t) => t.state === "review", "task in review");

    const done = await task({
      title: "Ship the changelog",
      objective: "Summarize the changes.",
      state: "ready",
    });
    await taskWhere(done.id, (t) => t.state === "review", "second task in review");
    await api("POST", `/api/tasks/${done.id}/accept`, { confirm: true });
    await taskWhere(done.id, (t) => t.state === "done", "task done");

    const running = await task({
      title: "Long running migration",
      objective: "SLOW-TASK keep working for a long time.",
      priority: 1,
      state: "ready",
    });
    const runningTask = await taskWhere(
      running.id,
      (t) => t.state === "in_progress" && !!t.sessionId,
      "task in progress",
    );
    await sessionWhere(
      runningTask.sessionId,
      (s) => s.runtime === "running",
      "running task session",
    );

    const ready = await task({
      title: "Queued follow-up work",
      objective: "Wait for the project slot.",
      state: "ready",
    });
    const backlog = await task({
      title: "Plan the onboarding flow",
      objective: "Sketch the steps.",
      acceptanceCriteria: ["Steps are listed"],
    });
    for (let i = 1; i <= 8; i++) {
      await task({ title: `Backlog idea ${i}`, objective: `Idea number ${i}.` });
    }

    const automation = await api("POST", "/api/automations", {
      name: "Nightly dependency check",
      enabled: false,
      projectId: project.id,
      trigger: { kind: "cron", expr: "0 3 * * *", timezone: "UTC" },
      template: {
        title: "Check dependencies",
        objective: "Look for outdated dependencies.",
        acceptanceCriteria: [],
        priority: 2,
      },
    });

    const state: E2EState = {
      baseURL: E2E_URL,
      adminToken,
      root,
      repoPath: repo.path,
      hostId,
      hostName: "e2e-host",
      projectId: project.id,
      projectName: "Demo project",
      workspaceId,
      sessions: { long, question },
      tasks: {
        backlog: backlog.id,
        ready: ready.id,
        running: running.id,
        review: review.id,
        done: done.id,
      },
      runningSessionId: runningTask.sessionId,
      reviewSessionId: reviewed.sessionId,
      automationId: automation.id,
      changedFiles,
    };
    const stateFile = join(root, "state.json");
    writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);
    process.env.SY_E2E_STATE = stateFile;
  } catch (err) {
    console.error(`[e2e] setup failed; logs kept in ${root}`);
    await teardown(true);
    throw err;
  }
}
