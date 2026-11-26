/**
 * A seeded demo of Switchyard for the site's product visuals: a real coordinator serving the
 * built web app, two host agents running real Pi against a scripted mock model, three made-up
 * projects of a made-up `acme` organization, a GitHub scope with its issues, and branches in every
 * stage. Nothing here touches real repositories, GitHub, model providers or your Pi setup.
 *
 * Run `pnpm build` at the repository root first. `node site/capture/demo-stack.ts` keeps it running
 * and prints a sign-in link; capture.ts starts it itself.
 */

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCoordinator, createLogger } from "../../packages/coordinator/dist/index.js";
import { runHostAgent } from "../../packages/host-agent/dist/index.js";
import {
  type MockReply,
  type MockRequest,
  piBin,
  startMockModel,
} from "../../packages/test-fixtures/dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const webDist = join(repoRoot, "packages", "web", "dist");
const e2eFixtures = join(repoRoot, "packages", "web", "e2e", "fixtures");

type Json = any;

export interface Demo {
  url: string;
  adminToken: string;
  root: string;
  hosts: Record<string, string>;
  projects: Record<string, string>;
  sessions: Record<string, string>;
  stop(): Promise<void>;
}

// ---------------------------------------------------------------------------------------------
// The made-up work: projects, branches and what the agent does on each.

interface Turn {
  text?: string;
  tool?: { name: string; arguments: Record<string, unknown> };
  /** Never answer this turn: the session stays running. */
  hold?: boolean;
}

interface BranchSeed {
  key: string;
  project: string;
  branch: string;
  title: string;
  prompt: string;
  turns: Turn[];
  issue?: number;
  pr?: { number: number; state: "OPEN" | "MERGED"; title: string };
}

const PROJECTS = [
  { key: "storefront", host: "laptop", files: storefrontFiles() },
  { key: "billing-api", host: "build-server", files: billingFiles() },
  { key: "docs", host: "laptop", files: docsFiles() },
] as const;

const RETRY_TS = `import { charge, type ChargeResult } from "../payments/client";

const DECLINE_RETRYABLE = new Set(["processing_error", "try_again_later"]);

/** Charges a card, retrying declines the issuer marks as temporary. */
export async function chargeWithRetry(order: Order, attempts: number): Promise<ChargeResult> {
  let result = await charge(order);
  for (let i = 1; i < attempts && isRetryable(result); i++) {
    await sleep(backoff(i));
    result = await charge(order);
  }
  return result;
}

const isRetryable = (r: ChargeResult) => r.status === "declined" && DECLINE_RETRYABLE.has(r.code);
`;

const BRANCHES: BranchSeed[] = [
  {
    key: "retry",
    project: "storefront",
    branch: "checkout-retry",
    title: "Retry declined card payments",
    issue: 38,
    prompt:
      "A temporary card decline fails the whole checkout (#38). Retry the declines the issuer marks as temporary before the shopper sees an error.",
    turns: [
      {
        text: "I'll start with how checkout handles a failed charge.",
        tool: { name: "bash", arguments: { command: "ls src/checkout src/payments" } },
      },
      {
        text: "Checkout calls `charge()` once and shows any decline as final. I'll add a retry wrapper that only retries the decline codes the issuer marks as temporary.",
        tool: {
          name: "write",
          arguments: { path: "src/checkout/retry.ts", content: RETRY_TS },
        },
      },
      {
        text: "Before I wire it into checkout I need one decision from you.",
        tool: {
          name: "ask_user_question",
          arguments: {
            questions: [
              {
                question: "How many times should a temporary decline be retried?",
                header: "Retries",
                multiSelect: false,
                options: [
                  { label: "Once", description: "After 2 seconds; fastest feedback" },
                  { label: "Three times", description: "With exponential backoff, up to 14 s" },
                  { label: "Never", description: "Show the decline right away" },
                ],
              },
            ],
          },
        },
      },
      { text: "Wiring it in with your choice now." },
    ],
  },
  {
    key: "a11y",
    project: "storefront",
    branch: "cart-focus",
    title: "Fix keyboard focus in the cart drawer",
    issue: 35,
    pr: { number: 36, state: "OPEN", title: "fix(cart): keep focus inside the open drawer" },
    prompt:
      "The cart drawer lets keyboard focus escape behind it (#35). Fix the focus order and add a test.",
    turns: [
      {
        text: "Looking at the drawer component.",
        tool: { name: "bash", arguments: { command: "grep -rn 'Drawer' src/cart" } },
      },
      {
        tool: {
          name: "write",
          arguments: {
            path: "src/cart/focus-trap.ts",
            content:
              'export function trapFocus(root: HTMLElement): () => void {\n  const focusable = () => root.querySelectorAll<HTMLElement>("a, button, input, [tabindex]");\n  const onKey = (e: KeyboardEvent) => {\n    if (e.key !== "Tab") return;\n    const items = [...focusable()];\n    const first = items[0];\n    const last = items.at(-1);\n    if (e.shiftKey && document.activeElement === first) { last?.focus(); e.preventDefault(); }\n    else if (!e.shiftKey && document.activeElement === last) { first?.focus(); e.preventDefault(); }\n  };\n  root.addEventListener("keydown", onKey);\n  return () => root.removeEventListener("keydown", onKey);\n}\n',
          },
        },
      },
      {
        text: "Done, and the pull request is open.\n\n- **Focus stays in the drawer** while it is open: Tab and Shift+Tab wrap around.\n- **Escape closes it** and returns focus to the cart button.\n- **A test** walks the drawer with the keyboard.\n\nReady for review in #36.",
      },
    ],
  },
  {
    key: "pdf",
    project: "billing-api",
    branch: "invoice-pdf",
    title: "Render invoices as PDF",
    issue: 52,
    prompt: "Render invoices as PDF and attach them to the receipt email (#52).",
    turns: [
      {
        text: "Checking what the receipt email sends today.",
        tool: { name: "bash", arguments: { command: "ls src/invoices src/email" } },
      },
      {
        text: "Receipts are plain HTML. I'll render the same template to PDF and attach it.",
        tool: {
          name: "write",
          arguments: {
            path: "src/invoices/pdf.ts",
            content:
              'import { renderInvoice } from "./template";\n\nexport async function invoicePdf(invoice: Invoice): Promise<Uint8Array> {\n  const html = renderInvoice(invoice);\n  return printToPdf(html, { format: "A4", margin: "16mm" });\n}\n',
          },
        },
      },
      { hold: true },
    ],
  },
  {
    key: "limits",
    project: "billing-api",
    branch: "rate-limits",
    title: "Per-customer rate limits",
    pr: { number: 50, state: "MERGED", title: "feat(api): per-customer rate limits" },
    prompt: "Add per-customer rate limits to the public API (#49).",
    turns: [
      {
        text: "Merged. Each API key now gets 600 requests a minute, with `Retry-After` on a 429 and the limit in the response headers.",
      },
    ],
  },
  {
    key: "guide",
    project: "docs",
    branch: "main",
    title: "Refresh the getting-started guide",
    prompt: "Update the getting-started guide for the new CLI flags.",
    turns: [
      {
        text: "Reading the guide.",
        tool: { name: "read", arguments: { path: "guide/getting-started.md" } },
      },
      {
        text: "Updated the guide: `--profile` replaces `--env`, and the install step now uses the one-line installer. Want me to open a pull request?",
      },
    ],
  },
];

const NOT_STARTED = [
  { repository: "acme/storefront", number: 41, title: "Add Apple Pay to checkout" },
  { repository: "acme/billing-api", number: 57, title: "Export invoices as CSV" },
  { repository: "acme/docs", number: 60, title: "Document webhook retries" },
];

function storefrontFiles(): Record<string, string> {
  return {
    "README.md": "# storefront\n\nThe Acme web shop.\n",
    "package.json": '{ "name": "storefront", "private": true }\n',
    "src/checkout/checkout.ts": 'import { charge } from "../payments/client";\n',
    "src/checkout/summary.ts": "export {};\n",
    "src/payments/client.ts": "export async function charge(order) {}\n",
    "src/payments/errors.ts": "export {};\n",
    "src/cart/drawer.tsx": "export function Drawer() { return null; }\n",
  };
}

function billingFiles(): Record<string, string> {
  return {
    "README.md": "# billing-api\n\nInvoices, receipts and the public billing API.\n",
    "package.json": '{ "name": "billing-api", "private": true }\n',
    "src/invoices/template.ts": "export {};\n",
    "src/invoices/totals.ts": "export {};\n",
    "src/email/receipt.ts": "export {};\n",
    "src/email/send.ts": "export {};\n",
  };
}

function docsFiles(): Record<string, string> {
  return {
    "README.md": "# docs\n\nAcme's developer documentation.\n",
    "guide/getting-started.md":
      "# Getting started\n\nInstall the CLI, then run `acme login --env prod`.\n",
  };
}

// ---------------------------------------------------------------------------------------------

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, {
    cwd,
    stdio: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Demo",
      GIT_AUTHOR_EMAIL: "demo@example.com",
      GIT_COMMITTER_NAME: "Demo",
      GIT_COMMITTER_EMAIL: "demo@example.com",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  });
}

function makeRepo(root: string, name: string, files: Record<string, string>): string {
  const path = join(root, "src", name);
  mkdirSync(path, { recursive: true });
  git(path, ["init", "-q", "-b", "main"]);
  git(path, ["config", "commit.gpgsign", "false"]);
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(path, file)), { recursive: true });
    writeFileSync(join(path, file), content);
  }
  git(path, ["add", "."]);
  git(path, ["commit", "-q", "-m", `feat: start ${name}`]);
  git(path, ["remote", "add", "origin", `https://github.com/acme/${name}.git`]);
  return path;
}

/** The scripted model: each session's first prompt picks its turns, the assistant count the step. */
function seedOf(req: MockRequest): { seed: BranchSeed | undefined; step: number } {
  const first = req.messages.find((m) => m.role === "user");
  const firstText = typeof first?.content === "string" ? first.content : JSON.stringify(first);
  const seed = BRANCHES.find((b) => firstText.includes(b.prompt.slice(0, 40)));
  return { seed, step: req.messages.filter((m) => m.role === "assistant").length };
}

function reply(req: MockRequest): MockReply {
  const { seed, step } = seedOf(req);
  if (!seed) return { text: "Done." };
  const turn = seed.turns[Math.min(step, seed.turns.length - 1)];
  if (turn.hold) return { delayMs: 24 * 3600_000, text: "" };
  return {
    text: turn.text,
    toolCalls: turn.tool ? [{ name: turn.tool.name, arguments: turn.tool.arguments }] : undefined,
    chunkDelayMs: 5,
  };
}

/**
 * Terminal holders outlive their host agent by design, and Pi runs under them. Stop every process
 * that still has a file open under the demo's root (sockets, logs, working directories).
 */
function killHolders(root: string): void {
  let out = "";
  try {
    out = execFileSync("lsof", ["-t", "+D", root], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (err) {
    out = String((err as { stdout?: string }).stdout ?? "");
  }
  for (const pid of new Set(out.split(/\s+/).map(Number))) {
    if (pid > 0 && pid !== process.pid) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {}
    }
  }
}

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
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`demo: timed out waiting for ${label}${last ? ` (${String(last)})` : ""}`);
}

export async function startDemo(opts: { port?: number } = {}): Promise<Demo> {
  if (!existsSync(join(webDist, "index.html")))
    throw new Error("packages/web/dist is missing; run `pnpm build` first");
  const port = opts.port ?? Number(process.env.SY_DEMO_PORT ?? 7490);
  const url = `http://127.0.0.1:${port}`;
  // A short root keeps the hosts' sockets inside it, and Pi shows paths under it as `~/src/...`.
  const root = realpathSync(
    mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "sy-demo-")),
  );

  // gh for the hosts only: answers from the scenario, never the real GitHub.
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  copyFileSync(join(here, "fake-gh.mjs"), join(bin, "gh"));
  chmodSync(join(bin, "gh"), 0o755);
  const ghScenario = join(root, "gh.json");
  writeFileSync(
    ghScenario,
    JSON.stringify({
      login: "you",
      pullRequests: BRANCHES.filter((b) => b.pr).map((b) => ({
        repository: `acme/${b.project}`,
        branch: b.branch,
        issue: b.issue,
        ...b.pr,
      })),
      issues: [
        ...BRANCHES.filter((b) => b.issue && b.pr?.state !== "MERGED").map((b) => ({
          repository: `acme/${b.project}`,
          number: b.issue,
          title: b.title,
          branch: b.branch,
        })),
        ...NOT_STARTED,
      ],
    }),
  );

  const mock = await startMockModel([{ when: () => true, reply }]);
  const agentDir = join(root, "pi-agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        demo: {
          baseUrl: mock.url,
          api: "openai-completions",
          apiKey: "demo",
          models: [
            {
              id: "sonnet",
              name: "Sonnet",
              reasoning: true,
              input: ["text"],
              contextWindow: 200000,
              maxTokens: 8192,
              cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    }),
  );
  writeFileSync(
    join(agentDir, "settings.json"),
    JSON.stringify({ defaultProvider: "demo", defaultModel: "sonnet" }),
  );
  // Pi and its tools see only this environment: none of yours (tokens, config, history).
  const keep = new Set(["PATH", "LANG", "LC_ALL", "TERM", "TMPDIR", "USER", "LOGNAME", "SHELL"]);
  const hostEnv = {
    ...Object.fromEntries(Object.keys(process.env).map((k) => [k, undefined])),
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => keep.has(k))),
    HOME: root,
    PI_CODING_AGENT_DIR: agentDir,
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    SWITCHYARD_DEMO_GH: ghScenario,
    // The demo remotes name github.com/acme/*, which must never be contacted.
    GIT_ALLOW_PROTOCOL: "file",
    GH_TOKEN: undefined,
    GITHUB_TOKEN: undefined,
  };

  const coordinator = createCoordinator({
    dataDir: join(root, "coordinator"),
    listen: { host: "127.0.0.1", port },
    publicUrl: url,
    trustedOrigins: [url, `http://localhost:${port}`],
    webDist,
    rateLimits: false,
    setupHint: false,
    logger: createLogger({
      level: "info",
      destination: createWriteStream(join(root, "coordinator.log")),
    }),
  });
  await coordinator.start();
  const adminToken = coordinator.adminToken;
  const api = async (method: string, path: string, body?: unknown): Promise<Json> => {
    const res = await fetch(`${url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${adminToken}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text}`);
    return text ? JSON.parse(text) : null;
  };

  const agents: { stop(): Promise<void> }[] = [];
  const hosts: Record<string, string> = {};
  for (const name of ["laptop", "build-server"]) {
    const enrollment = await api("POST", "/api/hosts/enrollments");
    const res = await fetch(`${url}/api/hosts/enroll`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: enrollment.token, name, platform: process.platform }),
    });
    if (res.status !== 201) throw new Error(`host enroll failed: ${await res.text()}`);
    const { hostId, credential } = (await res.json()) as { hostId: string; credential: string };
    hosts[name] = hostId;
    agents.push(
      await runHostAgent({
        config: { coordinatorUrl: url, hostId, credential, name },
        stateDir: join(root, `host-${name}`),
        piBin: piBin(),
        env: hostEnv,
        extraExtensions: [join(e2eFixtures, "ask-extension.js")],
        ownerAdapterDir: join(e2eFixtures, "adapters"),
        handleSignals: false,
        terminalSessions: true,
        backoffMs: [100, 200, 500],
        logger: createLogger({
          level: "info",
          destination: createWriteStream(join(root, `host-${name}.log`)),
        }) as never,
      }),
    );
  }

  const stop = async () => {
    for (const a of agents) await a.stop().catch(() => {});
    killHolders(root);
    await coordinator.stop().catch(() => {});
    await mock.close().catch(() => {});
    if (!process.env.SY_DEMO_KEEP) rmSync(root, { recursive: true, force: true });
  };

  try {
    for (const id of Object.values(hosts))
      await waitFor("host connected", async () => {
        const h = await api("GET", `/api/hosts/${id}`);
        return (h.host ?? h).connectivity === "connected";
      });

    const projects: Record<string, string> = {};
    for (const p of PROJECTS) {
      const path = makeRepo(root, p.key, p.files);
      const project = await api("POST", "/api/projects", {
        hostId: hosts[p.host],
        path,
        name: p.key,
      });
      projects[p.key] = project.id;
      await waitFor(`${p.key} workspace`, async () => {
        const got = await api("GET", `/api/projects/${project.id}`);
        return got.workspaces?.length > 0;
      });
    }

    const scope = await api("POST", "/api/scopes", {
      name: "acme",
      source: { hostId: hosts.laptop, owner: "acme", worktrees: false },
    });

    const sessions: Record<string, string> = {};
    for (const b of BRANCHES) {
      const p = PROJECTS.find((x) => x.key === b.project)!;
      const opened = await api("POST", "/api/branches/open", {
        projectId: projects[b.project],
        branch: b.branch,
        hostId: hosts[p.host],
        title: b.title,
        prompt: b.prompt,
      });
      sessions[b.key] = opened.session.id;
    }
    const session = (id: string) => api("GET", `/api/sessions/${id}`);
    await waitFor("question pending", async () => {
      const list = await api("GET", `/api/interactions?sessionId=${sessions.retry}`);
      const items: Json[] = Array.isArray(list) ? list : (list.items ?? []);
      return items.some((i) => i.state === "pending");
    });
    const pdf = BRANCHES.find((b) => b.key === "pdf")!;
    await waitFor("invoice session holding", async () => {
      const held = mock.requests.some((r) => {
        const { seed, step } = seedOf(r);
        return seed === pdf && step === pdf.turns.length - 1;
      });
      return held && (await session(sessions.pdf)).runtime === "running";
    });
    for (const key of ["a11y", "limits", "guide"])
      await waitFor(`${key} idle`, async () => {
        const s = await session(sessions[key]);
        return s.runtime === "idle" && !!s.lastAssistantText;
      });
    await api("POST", `/api/scopes/${scope.id}/sync`).catch(() => {});
    return { url, adminToken, root, hosts, projects, sessions, stop };
  } catch (err) {
    console.error(`[demo] setup failed; logs in ${root}`);
    process.env.SY_DEMO_KEEP = "1";
    await stop();
    throw err;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const demo = await startDemo();
  const e = await fetch(`${demo.url}/api/devices/enrollments`, {
    method: "POST",
    headers: { authorization: `Bearer ${demo.adminToken}` },
  }).then((r) => r.json() as Promise<{ token: string }>);
  console.log(`[demo] ${demo.url} (data in ${demo.root})`);
  console.log(`[demo] admin token: ${demo.adminToken}`);
  console.log(`[demo] sessions: ${JSON.stringify(demo.sessions)}`);
  console.log(`[demo] device enrollment token: ${e.token}`);
  const done = async () => {
    await demo.stop();
    process.exit(0);
  };
  process.on("SIGINT", done);
  process.on("SIGTERM", done);
}
