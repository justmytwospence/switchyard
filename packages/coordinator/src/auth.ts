import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Device, type Host, newId, SwitchyardError } from "@switchyard/protocol";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { CoordinatorConfig } from "./context.js";
import type { EventHub } from "./event-hub.js";
import type { Owner } from "./owner.js";
import type { Store } from "./store.js";

export const DEVICE_COOKIE = "sy_device";
export const CSRF_HEADER = "x-switchyard-request";
export const ADMIN_DEVICE_ID = "dev_localadmin";
export const DEVICE_ENROLLMENT_TTL_MS = 10 * 60_000;
export const HOST_ENROLLMENT_TTL_MS = 30 * 60_000;

export type AuthedDevice = Device & { isAdmin: boolean };

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** 32 random bytes, base64url. */
export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export interface CreatedEnrollment {
  id: string;
  kind: "device" | "host";
  token: string;
  expiresAt: string;
  url: string;
  command: string | null;
}

/** Enrollment, credentials, request authentication and CSRF rules. */
export class Auth {
  constructor(
    private readonly store: Store,
    private readonly config: CoordinatorConfig,
    private readonly hub: EventHub,
    private readonly owner: Owner,
  ) {}

  get adminTokenPath(): string {
    return join(this.config.dataDir, "admin.token");
  }

  /** Read or create `admin.token` (0600) and register it as the implicit local admin device. */
  ensureAdminToken(): string {
    let token: string;
    if (existsSync(this.adminTokenPath)) {
      token = readFileSync(this.adminTokenPath, "utf8").trim();
    } else {
      token = newToken();
      writeFileSync(this.adminTokenPath, `${token}\n`, { mode: 0o600 });
    }
    chmodSync(this.adminTokenPath, 0o600);
    const hash = sha256(token);
    const now = this.store.nowIso();
    this.store.tx(() => {
      const existing = this.store.devices.get(ADMIN_DEVICE_ID);
      const device: Device = existing
        ? { ...existing, enrolledVia: "admin" }
        : {
            id: ADMIN_DEVICE_ID,
            name: "local admin",
            kind: "cli",
            createdAt: now,
            lastSeenAt: null,
            revokedAt: null,
            push: { subscribed: false, permission: "unknown" },
            preferredMobile: false,
            enrolledVia: "admin",
          };
      this.store.devices.upsert(device, { credential_hash: hash, is_admin: 1 });
    });
    return token;
  }

  /** Non-admin, non-revoked devices. */
  activeDeviceCount(): number {
    return this.store.devices.count("is_admin = 0 AND revoked_at IS NULL");
  }

  enrollmentUrl(token: string, kind: "device" | "host"): string {
    return kind === "device"
      ? `${this.config.publicUrl}/enroll#token=${token}`
      : `${this.config.publicUrl}/enroll#token=${token}&kind=host`;
  }

  hostEnrollCommand(token: string): string {
    return `switchyard host enroll --coordinator ${this.config.publicUrl} --token ${token}`;
  }

  /**
   * Create a single-use enrollment (device 10 min, host 30 min by default). An enrollment created
   * by a device (the local admin included) also marks the server set up.
   */
  createEnrollment(
    kind: "device" | "host",
    createdBy: string | null,
    ttlMs = kind === "device" ? DEVICE_ENROLLMENT_TTL_MS : HOST_ENROLLMENT_TTL_MS,
  ): CreatedEnrollment {
    const token = newToken();
    const id = newId("enr");
    const now = this.store.now();
    const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
    this.store.tx(() => {
      if (createdBy !== null) this.owner.markInitialized();
      this.store.insertEnrollment({
        id,
        kind,
        token_hash: sha256(token),
        expires_at: expiresAt,
        used_at: null,
        result_id: null,
        created_by: createdBy,
        created_at: now.toISOString(),
      });
    });
    return {
      id,
      kind,
      token,
      expiresAt,
      url: this.enrollmentUrl(token, kind),
      command: kind === "host" ? this.hostEnrollCommand(token) : null,
    };
  }

  /** Validate and consume an enrollment token inside the caller's transaction. */
  private consume(token: string, kind: "device" | "host", resultId: string): void {
    const row = this.store.enrollmentByHash(sha256(token));
    if (!row) throw new SwitchyardError("unauthorized", "Unknown enrollment token");
    if (row.kind !== kind) {
      throw new SwitchyardError("forbidden", `This token enrolls a ${row.kind}, not a ${kind}`);
    }
    if (row.used_at)
      throw new SwitchyardError("enrollment_used", "This enrollment was already used");
    if (Date.parse(row.expires_at) <= this.store.now().getTime()) {
      throw new SwitchyardError("enrollment_expired", "This enrollment has expired");
    }
    if (!this.store.markEnrollmentUsed(row.id, resultId)) {
      throw new SwitchyardError("enrollment_used", "This enrollment was already used");
    }
  }

  redeemDevice(
    token: string,
    name: string,
    kind: Device["kind"],
  ): { device: Device; credential: string } {
    const id = newId("dev");
    return this.store.tx(() => {
      this.consume(token, "device", id);
      return this.createDevice(name, kind, "enrollment", id);
    });
  }

  /** Create a device and its credential (enrollment, passkey or OIDC sign-in). */
  createDevice(
    name: string,
    kind: Device["kind"],
    via: Device["enrolledVia"],
    id: string = newId("dev"),
  ): { device: Device; credential: string } {
    const credential = newToken();
    const device = this.store.tx(() => {
      const d: Device = {
        id,
        name,
        kind,
        createdAt: this.store.nowIso(),
        lastSeenAt: this.store.nowIso(),
        revokedAt: null,
        push: { subscribed: false, permission: "unknown" },
        preferredMobile: false,
        enrolledVia: via,
      };
      this.store.devices.upsert(d, { credential_hash: sha256(credential), is_admin: 0 });
      this.store.appendEvent("device.updated", {}, d);
      return d;
    });
    return { device, credential };
  }

  redeemHost(
    token: string,
    name: string,
    platform: Host["platform"],
  ): { host: Host; credential: string } {
    const id = newId("hst");
    return this.store.tx(() => {
      this.consume(token, "host", id);
      return this.createHost(name, platform, id);
    });
  }

  /** Enroll a host with the shared `SWITCHYARD_HOST_ENROLL_SECRET`. Each host stays revocable. */
  redeemHostSecret(
    secret: string,
    name: string,
    platform: Host["platform"],
  ): { host: Host; credential: string } {
    const expected = this.config.hostEnrollSecret;
    if (!expected) {
      throw new SwitchyardError(
        "forbidden",
        "Shared host enrollment is not enabled on this server",
      );
    }
    if (!safeEqualHex(sha256(secret), sha256(expected))) {
      throw new SwitchyardError("unauthorized", "Wrong host enrollment secret");
    }
    return this.createHost(name, platform, newId("hst"));
  }

  private createHost(
    name: string,
    platform: Host["platform"],
    id: string,
  ): { host: Host; credential: string } {
    const credential = newToken();
    const host = this.store.tx(() => {
      const h: Host = {
        id,
        name,
        platform,
        agentVersion: "unknown",
        piVersion: null,
        piCompatible: false,
        capabilities: null,
        connectivity: "unreachable",
        lastSeenAt: null,
        revokedAt: null,
        createdAt: this.store.nowIso(),
      };
      this.store.hosts.upsert(h, { credential_hash: sha256(credential) });
      this.store.appendEvent("host.updated", { hostId: id }, h);
      return h;
    });
    return { host, credential };
  }

  /** Resolve a device credential; throws `unauthorized` or `device_revoked`. */
  authenticateCredential(credential: string): AuthedDevice {
    const device = this.store.deviceByCredentialHash(sha256(credential));
    if (!device) throw new SwitchyardError("unauthorized", "Unknown device credential");
    if (device.revokedAt) throw new SwitchyardError("device_revoked", "This device was revoked");
    this.touch(device);
    return device;
  }

  /** Update `lastSeenAt` at most once a minute, without an event. */
  private touch(device: AuthedDevice): void {
    const now = this.store.now();
    if (device.lastSeenAt && now.getTime() - Date.parse(device.lastSeenAt) < 60_000) return;
    const { isAdmin: _a, ...plain } = device;
    const updated: Device = { ...plain, lastSeenAt: now.toISOString() };
    this.store.tx(() => this.store.devices.upsert(updated));
    device.lastSeenAt = updated.lastSeenAt;
  }

  /** Extract a credential from `Authorization: Bearer` (preferred) or the device cookie. */
  credentialOf(req: FastifyRequest): { credential: string; via: "bearer" | "cookie" } | null {
    const h = req.headers.authorization;
    if (h?.startsWith("Bearer ")) return { credential: h.slice(7).trim(), via: "bearer" };
    const c = (req.cookies as Record<string, string | undefined> | undefined)?.[DEVICE_COOKIE];
    if (c) return { credential: c, via: "cookie" };
    return null;
  }

  isTrustedOrigin(origin: string | undefined): boolean {
    return !!origin && this.config.trustedOrigins.includes(origin);
  }

  /**
   * Authenticate a request and enforce CSRF: cookie-authenticated non-GET requests need
   * `X-Switchyard-Request: 1` and a trusted `Origin`. Cookie-authenticated WebSocket upgrades
   * need a trusted `Origin` when one is sent.
   */
  authenticateRequest(req: FastifyRequest, opts: { websocket?: boolean } = {}): AuthedDevice {
    const cred = this.credentialOf(req);
    if (!cred) throw new SwitchyardError("unauthorized", "Not authenticated");
    const device = this.authenticateCredential(cred.credential);
    if (cred.via === "cookie") {
      const safe = req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS";
      if (opts.websocket) {
        const origin = req.headers.origin;
        if (origin && !this.isTrustedOrigin(origin)) {
          throw new SwitchyardError("forbidden", `Origin ${origin} is not trusted`);
        }
      } else if (!safe) {
        if (req.headers[CSRF_HEADER] !== "1") {
          throw new SwitchyardError("forbidden", "Missing X-Switchyard-Request header");
        }
        if (!this.isTrustedOrigin(req.headers.origin)) {
          throw new SwitchyardError(
            "forbidden",
            `Origin ${req.headers.origin ?? "(none)"} is not trusted`,
          );
        }
      }
    }
    req.device = device;
    req.authVia = cred.via;
    return device;
  }

  setDeviceCookie(reply: FastifyReply, credential: string): void {
    reply.setCookie(DEVICE_COOKIE, credential, {
      httpOnly: true,
      sameSite: "strict",
      secure: this.config.secureCookies,
      path: "/",
      maxAge: 400 * 86_400,
    });
  }

  clearDeviceCookie(reply: FastifyReply): void {
    reply.clearCookie(DEVICE_COOKIE, {
      path: "/",
      httpOnly: true,
      sameSite: "strict",
      secure: this.config.secureCookies,
    });
  }

  /** Revoke a device; its sockets get `force_logout` via the `device.revoked` hub event. */
  revokeDevice(id: string): Device {
    if (id === ADMIN_DEVICE_ID) {
      throw new SwitchyardError("forbidden", "The local admin token cannot be revoked here");
    }
    const device = this.store.tx(() => {
      const d = this.store.devices.require(id);
      if (d.revokedAt) return d;
      const updated: Device = {
        ...d,
        revokedAt: this.store.nowIso(),
        push: { ...d.push, subscribed: false },
      };
      this.store.deletePushSubscriptionsForDevice(id);
      return this.store.putDevice(updated);
    });
    this.hub.emit("device.revoked", { deviceId: id });
    return device;
  }
}
