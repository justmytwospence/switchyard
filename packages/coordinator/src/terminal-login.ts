import { randomInt } from "node:crypto";
import {
  SwitchyardError,
  type TerminalLoginClaimResponse,
  type TerminalLoginRequest,
  type TerminalLoginStartResponse,
} from "@switchyard/protocol";
import { type Auth, newToken, safeEqualHex, sha256 } from "./auth.js";
import type { CoordinatorConfig } from "./context.js";
import { AuthFlows } from "./owner.js";
import type { Store } from "./store.js";

export const TERMINAL_LOGIN_TTL_MS = 10 * 60_000;
export const TERMINAL_LOGIN_POLL_MS = 2000;
const CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";

/** Uppercase and drop everything that is not A-Z (`bcdf-ghjk` becomes `BCDFGHJK`). */
export function normalizeUserCode(s: string): string {
  return s.toUpperCase().replace(/[^A-Z]/g, "");
}

export function formatUserCode(n: string): string {
  return `${n.slice(0, 4)}-${n.slice(4)}`;
}

interface TerminalFlow {
  name: string;
  requestedFrom: string;
  createdAt: string;
  expiresAt: string;
  pollTokenHash: string;
  status: "pending" | "approved" | "denied";
}

/** Device-code style terminal sign-in: a signed-in browser approves a code the terminal shows. */
export class TerminalLogins {
  private readonly flows: AuthFlows;

  constructor(
    private readonly store: Store,
    private readonly config: CoordinatorConfig,
    private readonly auth: Auth,
  ) {
    this.flows = new AuthFlows(store);
  }

  private load(code: string): { id: string; flow: TerminalFlow } {
    const id = normalizeUserCode(code);
    const flow = this.flows.get<TerminalFlow>("terminal_login", id);
    if (!flow) {
      throw new SwitchyardError(
        "not_found",
        "This sign-in request expired or does not exist. Run `switchyard login` again.",
      );
    }
    return { id, flow };
  }

  private view(id: string, flow: TerminalFlow): TerminalLoginRequest {
    return {
      userCode: formatUserCode(id),
      name: flow.name,
      requestedFrom: flow.requestedFrom,
      createdAt: flow.createdAt,
      expiresAt: flow.expiresAt,
      status: flow.status,
    };
  }

  start(name: string, requestedFrom: string): TerminalLoginStartResponse {
    let id = "";
    for (let attempt = 0; attempt < 5 && !id; attempt++) {
      let candidate = "";
      for (let i = 0; i < 8; i++) candidate += CODE_ALPHABET[randomInt(0, CODE_ALPHABET.length)];
      if (!this.flows.get("terminal_login", candidate)) id = candidate;
    }
    if (!id) throw new SwitchyardError("internal", "Could not allocate a sign-in code");
    const pollToken = newToken();
    const now = this.store.now();
    const createdAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + TERMINAL_LOGIN_TTL_MS).toISOString();
    const flow: TerminalFlow = {
      name,
      requestedFrom,
      createdAt,
      expiresAt,
      pollTokenHash: sha256(pollToken),
      status: "pending",
    };
    this.flows.put("terminal_login", id, flow, TERMINAL_LOGIN_TTL_MS);
    const userCode = formatUserCode(id);
    return {
      userCode,
      pollToken,
      verifyUrl: `${this.config.publicUrl}/terminal-login?code=${userCode}`,
      expiresAt,
      intervalMs: TERMINAL_LOGIN_POLL_MS,
    };
  }

  describe(code: string): TerminalLoginRequest {
    const { id, flow } = this.load(code);
    return this.view(id, flow);
  }

  approve(code: string): TerminalLoginRequest {
    return this.store.tx(() => {
      const { id, flow } = this.load(code);
      if (flow.status !== "pending") {
        throw new SwitchyardError("invalid_request", "This sign-in was already approved or denied");
      }
      const next: TerminalFlow = { ...flow, status: "approved" };
      this.flows.update(id, next);
      return this.view(id, next);
    });
  }

  deny(code: string): TerminalLoginRequest {
    return this.store.tx(() => {
      const { id, flow } = this.load(code);
      if (flow.status !== "pending") {
        throw new SwitchyardError("invalid_request", "This sign-in was already approved or denied");
      }
      const next: TerminalFlow = { ...flow, status: "denied" };
      this.flows.update(id, next);
      return this.view(id, next);
    });
  }

  claim(code: string, pollToken: string): TerminalLoginClaimResponse {
    return this.store.tx(() => {
      const id = normalizeUserCode(code);
      const flow = this.flows.get<TerminalFlow>("terminal_login", id);
      if (!flow || !safeEqualHex(sha256(pollToken), flow.pollTokenHash)) {
        throw new SwitchyardError("unauthorized", "Unknown or expired sign-in");
      }
      if (flow.status === "pending") return { status: "pending" };
      this.flows.delete(id);
      if (flow.status === "denied") return { status: "denied" };
      // The device and its credential exist only once the terminal claims them.
      const { device, credential } = this.auth.createDevice(flow.name, "terminal", "approval");
      return { status: "done", deviceId: device.id, credential };
    });
  }
}
