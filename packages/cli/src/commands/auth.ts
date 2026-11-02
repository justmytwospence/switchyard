import { hostname } from "node:os";
import { ApiClient } from "@switchyard/terminal";
import QRCode from "qrcode";
import {
  CliError,
  DEFAULT_LOCAL_URL,
  readAdminToken,
  readEndpoint,
  trimUrl,
  writeClientConfig,
} from "../config.js";
import type { Ctx } from "../context.js";
import { clientConfigPath, defaultDataDir } from "../paths.js";

export interface PairFlags {
  host?: boolean;
  coordinator?: string;
  dataDir?: string;
  json?: boolean;
}

interface EnrollmentResponse {
  token: string;
  url: string;
  expiresAt: string;
  command: string | null;
}

/**
 * Create a single-use device (or host) enrollment with the local admin token and print the
 * URL with a terminal QR code. The QR only carries the URL and token: the device must already
 * be able to reach that URL (LAN, VPN or reverse proxy).
 */
export async function pair(ctx: Ctx, flags: PairFlags): Promise<EnrollmentResponse> {
  const dataDir = flags.dataDir ?? ctx.paths?.dataDir ?? defaultDataDir(ctx.env);
  const token = readAdminToken(dataDir, ctx.env);
  if (!token) {
    throw new CliError(
      `No admin token: run this on the coordinator machine (looked in ${dataDir}/admin.token) or set SWITCHYARD_ADMIN_TOKEN`,
    );
  }
  const url = trimUrl(flags.coordinator ?? readEndpoint(dataDir)?.localUrl ?? DEFAULT_LOCAL_URL);
  const api = new ApiClient({ coordinatorUrl: url, credential: token, fetch: ctx.fetch });
  const kind = flags.host ? "host" : "device";
  const e = await api.post<EnrollmentResponse>("/api/enrollments", { kind });
  if (flags.json) {
    ctx.out(JSON.stringify(e, null, 2));
    return e;
  }
  const qr = await QRCode.toString(e.url, { type: "terminal", small: true });
  if (kind === "host") {
    ctx.out(`Host enrollment (single use, expires ${e.expiresAt}). On the host, run:`);
    ctx.out("");
    ctx.out(`  ${e.command ?? `switchyard host enroll --coordinator <url> --token ${e.token}`}`);
    ctx.out("");
    ctx.out(`Token: ${e.token}`);
  } else {
    ctx.out(`Open this link on the device to enroll it (single use, expires ${e.expiresAt}):`);
    ctx.out("");
    ctx.out(`  ${e.url}`);
    ctx.out("");
    ctx.out(qr.trimEnd());
    ctx.out("");
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
  token: string;
  name?: string;
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
export async function login(
  ctx: Ctx,
  flags: LoginFlags,
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
  ctx.out(`Credential saved to ${path} (mode 0600). Run \`switchyard attach\` to open sessions.`);
  return { path, deviceId: res.deviceId };
}
