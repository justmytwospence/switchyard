import { hostname } from "node:os";
import type {
  CreateEnrollmentResponse,
  TerminalLoginClaimResponse,
  TerminalLoginStartResponse,
} from "@switchyard/protocol";
import { ApiClient, ApiRequestError } from "@switchyard/terminal";
import QRCode from "qrcode";
import {
  CliError,
  DEFAULT_LOCAL_URL,
  readAdminToken,
  readClientConfig,
  readEndpoint,
  trimUrl,
  writeClientConfig,
} from "../config.js";
import type { Ctx } from "../context.js";
import { clientConfigPath, defaultDataDir } from "../paths.js";
import { openBrowser } from "./up.js";

export interface PairFlags {
  host?: boolean;
  coordinator?: string;
  dataDir?: string;
  json?: boolean;
}

/** An API client authenticated with this machine's local admin token. */
function adminApi(ctx: Ctx, flags: { coordinator?: string; dataDir?: string }): ApiClient {
  const dataDir = flags.dataDir ?? ctx.paths?.dataDir ?? defaultDataDir(ctx.env);
  const token = readAdminToken(dataDir, ctx.env);
  if (!token) {
    throw new CliError(
      `No admin token: run this on the coordinator machine (looked in ${dataDir}/admin.token) or set SWITCHYARD_ADMIN_TOKEN`,
    );
  }
  const url = trimUrl(flags.coordinator ?? readEndpoint(dataDir)?.localUrl ?? DEFAULT_LOCAL_URL);
  return new ApiClient({ coordinatorUrl: url, credential: token, fetch: ctx.fetch });
}

/** `HH:MM` in local time. */
export function clockTime(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Print a device sign-in link with its terminal QR code. */
export async function printDeviceLink(ctx: Ctx, url: string): Promise<void> {
  const qr = await QRCode.toString(url, { type: "terminal", small: true });
  ctx.out("");
  ctx.out(`  ${url}`);
  ctx.out("");
  ctx.out(qr.trimEnd());
  ctx.out("");
}

/** Print a single-use browser sign-in link with its QR code (`pair`, and `up`'s first start). */
export async function printSignInLink(ctx: Ctx, url: string, expiresAt: string): Promise<void> {
  ctx.out(`Open this single-use sign-in link in your browser (expires ${clockTime(expiresAt)}):`);
  await printDeviceLink(ctx, url);
  ctx.out(
    "Then add a passkey in Settings › Sign-in as a backup, or run `switchyard pair` for another browser.",
  );
}

/**
 * Create a single-use device (or host) enrollment with the local admin token and print the
 * URL with a terminal QR code. The QR only carries the URL and token: the device must already
 * be able to reach that URL (LAN, VPN or reverse proxy). Also the recovery path when every
 * signed-in device is lost.
 */
export async function pair(ctx: Ctx, flags: PairFlags): Promise<CreateEnrollmentResponse> {
  const api = adminApi(ctx, flags);
  const kind = flags.host ? "host" : "device";
  const e = await api.post<CreateEnrollmentResponse>("/api/enrollments", { kind });
  if (flags.json) {
    ctx.out(JSON.stringify(e, null, 2));
    return e;
  }
  if (kind === "host") {
    ctx.out(`Host enrollment (single use, expires ${clockTime(e.expiresAt)}). On the host, run:`);
    ctx.out("");
    ctx.out(`  ${e.command ?? `switchyard host enroll --coordinator <url> --token ${e.token}`}`);
    ctx.out("");
    ctx.out(`Token: ${e.token}`);
  } else {
    await printSignInLink(ctx, e.url, e.expiresAt);
    ctx.out(`Terminal: switchyard login --coordinator ${originOf(e.url)} --token ${e.token}`);
  }
  ctx.out("The link does not provide network access: the device must already reach this URL.");
  return e;
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

export interface LoginFlags {
  coordinator?: string;
  token?: string;
  name?: string;
  open?: boolean;
}

export interface LoginDeps {
  open?: (url: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** Accept a bare token or an enrollment URL (`.../enroll#token=...`). */
export function parseEnrollmentInput(
  token: string,
  coordinator: string | undefined,
): { url: string; token: string } {
  const t = token.trim();
  if (/^https?:\/\//.test(t)) {
    const u = new URL(t);
    const params = new URLSearchParams(u.hash.replace(/^#/, ""));
    const fromUrl = params.get("token") ?? u.searchParams.get("token");
    if (!fromUrl) throw new CliError("That URL has no enrollment token");
    return { url: trimUrl(coordinator ?? u.origin), token: fromUrl };
  }
  if (!coordinator) throw new CliError("--coordinator <url> is required");
  return { url: trimUrl(coordinator), token: t };
}

/** Enroll this terminal as a `terminal` device and store the credential (mode 0600). */
export async function loginWithToken(
  ctx: Ctx,
  flags: LoginFlags & { token: string },
): Promise<{ path: string; deviceId: string }> {
  const { url, token } = parseEnrollmentInput(flags.token, flags.coordinator);
  const api = new ApiClient({ coordinatorUrl: url, credential: null, fetch: ctx.fetch });
  const name = flags.name ?? `${hostname().replace(/\.local$/, "")} terminal`;
  const res = await api.post<{ deviceId: string; credential: string }>("/api/enroll", {
    token,
    name,
    kind: "terminal",
  });
  if (!res.credential) throw new CliError("The coordinator returned no credential");
  const path = ctx.paths?.clientConfig ?? clientConfigPath(ctx.env);
  writeClientConfig(path, {
    coordinatorUrl: url,
    credential: res.credential,
    deviceId: res.deviceId,
  });
  ctx.out(`Enrolled "${name}" (${res.deviceId}) with ${url}.`);
  ctx.out(
    `Credential saved to ${path} (mode 0600). Open a session's Pi terminal with \`switchyard tui <session>\`.`,
  );
  return { path, deviceId: res.deviceId };
}

const EXPIRED = "The sign-in expired before it was approved. Run `switchyard login` again.";

/**
 * Sign this terminal in: with `--token`, redeem a `switchyard pair` link; otherwise show a code
 * and link to approve in a signed-in browser, and poll until it is approved.
 */
export async function login(
  ctx: Ctx,
  flags: LoginFlags,
  deps: LoginDeps = {},
): Promise<{ path: string; deviceId: string }> {
  if (flags.token) return loginWithToken(ctx, { ...flags, token: flags.token });
  const path = ctx.paths?.clientConfig ?? clientConfigPath(ctx.env);
  const raw = flags.coordinator ?? ctx.env.SWITCHYARD_URL ?? readClientConfig(path)?.coordinatorUrl;
  if (!raw) throw new CliError("--coordinator <url> is required");
  const url = trimUrl(raw);
  const api = new ApiClient({ coordinatorUrl: url, credential: null, fetch: ctx.fetch });
  const name = flags.name ?? `${hostname().replace(/\.local$/, "")} terminal`;
  const started = await api.post<TerminalLoginStartResponse>("/api/auth/terminal/start", { name });
  ctx.out("To sign in this terminal, open this link in a browser where you use Switchyard:");
  ctx.out("");
  ctx.out(`  ${started.verifyUrl}`);
  ctx.out("");
  ctx.out(
    `Check that it shows the code ${started.userCode}. Waiting for approval (expires ${clockTime(started.expiresAt)})…`,
  );
  const interactive = process.stdout.isTTY === true && !ctx.env.SSH_CONNECTION && !ctx.env.SSH_TTY;
  if (flags.open ?? interactive) (deps.open ?? ((u) => openBrowser(u)))(started.verifyUrl);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const deadline = Date.parse(started.expiresAt);
  for (;;) {
    await sleep(started.intervalMs);
    let r: TerminalLoginClaimResponse;
    try {
      r = await api.post<TerminalLoginClaimResponse>("/api/auth/terminal/claim", {
        userCode: started.userCode,
        pollToken: started.pollToken,
      });
    } catch (err) {
      if (err instanceof ApiRequestError) {
        if (err.status === 401) throw new CliError(EXPIRED);
        if (err.status === 0 && now() < deadline) continue;
      }
      throw err;
    }
    if (r.status === "denied") throw new CliError("The sign-in was denied in the browser.");
    if (r.status === "done") {
      writeClientConfig(path, {
        coordinatorUrl: url,
        credential: r.credential,
        deviceId: r.deviceId,
      });
      ctx.out(`Signed in "${name}" (${r.deviceId}) to ${url}.`);
      ctx.out(
        `Credential saved to ${path} (mode 0600). Open a session's Pi terminal with \`switchyard tui <session>\`.`,
      );
      return { path, deviceId: r.deviceId };
    }
    if (now() >= deadline) throw new CliError(EXPIRED);
  }
}
