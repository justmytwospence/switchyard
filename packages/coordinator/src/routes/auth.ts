import {
  type AuthMethods,
  EnrollRequest,
  type InitResponse,
  type MeResponse,
  OidcBeginRequest,
  OidcClaimRequest,
  PasskeyRegisterVerifyRequest,
  PasskeySignInVerifyRequest,
  type SetupState,
  SwitchyardError,
} from "@switchyard/protocol";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ADMIN_DEVICE_ID } from "../auth.js";
import type { CoordinatorContext } from "../context.js";
import { deviceOf, parse } from "../http.js";
import { OIDC_CALLBACK_PATH } from "../oidc.js";
import { enrollmentResponse } from "./devices.js";

const HANDOFF_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Signed in</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5}</style>
</head><body><h1>Signed in.</h1><p>Return to the Switchyard app to continue.</p></body></html>
`;

function setupState(ctx: CoordinatorContext): SetupState {
  const availability = ctx.owner.passkeyAvailability();
  return {
    initialized: ctx.owner.isInitialized(),
    passkey: {
      available: availability.available,
      registered: ctx.passkeys.count() > 0,
      reason: availability.reason,
    },
    oidc: ctx.config.oidc ? { label: ctx.config.oidc.label } : null,
  };
}

function requireOidc(ctx: CoordinatorContext) {
  if (!ctx.oidc) {
    throw new SwitchyardError(
      "unsupported_capability",
      "Single sign-on is not configured on this server",
    );
  }
  return ctx.oidc;
}

export function registerAuthRoutes(app: FastifyInstance, ctx: CoordinatorContext): void {
  const limitAuth = (req: FastifyRequest) => ctx.limiters.auth.check(req);

  /** Redeem a device enrollment. Browsers get the HttpOnly cookie and no credential in the body. */
  app.post("/api/enroll", async (req, reply) => {
    limitAuth(req);
    const body = parse(EnrollRequest, req.body);
    const { device, credential } = ctx.auth.redeemDevice(body.token, body.name, body.kind);
    const browser = body.kind === "browser" || body.kind === "pwa";
    if (browser) ctx.auth.setDeviceCookie(reply, credential);
    return reply.code(201).send({ deviceId: device.id, credential: browser ? "" : credential });
  });

  app.get("/api/me", async (req): Promise<MeResponse> => {
    const { isAdmin, ...device } = deviceOf(req);
    // Devices enrolled before 0.2 have no `enrolledVia` in their stored JSON.
    return {
      device: { ...device, enrolledVia: device.enrolledVia ?? "enrollment" },
      admin: isAdmin,
      publicUrl: ctx.config.publicUrl,
    };
  });

  /** Clear this browser's cookie (does not revoke the device). */
  app.post("/api/logout", async (_req, reply) => {
    ctx.auth.clearDeviceCookie(reply);
    return { ok: true };
  });

  // ---- public: setup state and owner sign-in ------------------------------------------------

  app.get("/api/setup", async (): Promise<SetupState> => setupState(ctx));

  app.post("/api/auth/passkey/options", async (req) => {
    limitAuth(req);
    return ctx.passkeys.signInOptions();
  });

  app.post("/api/auth/passkey/verify", async (req, reply) => {
    limitAuth(req);
    const body = parse(PasskeySignInVerifyRequest, req.body);
    const { device, credential } = await ctx.passkeys.signInVerify(
      body.challengeId,
      body.response,
      body.deviceName,
      body.kind,
    );
    ctx.auth.setDeviceCookie(reply, credential);
    return reply.code(201).send({ deviceId: device.id, credential: "" });
  });

  app.post("/api/auth/oidc/begin", async (req) => {
    limitAuth(req);
    const oidc = requireOidc(ctx);
    const body = parse(OidcBeginRequest, req.body);
    return oidc.begin(body);
  });

  app.get(OIDC_CALLBACK_PATH, async (req, reply) => {
    try {
      limitAuth(req);
      const oidc = requireOidc(ctx);
      // The URL as the browser requested it (the redirect URI is always built from publicUrl).
      const current = new URL(req.url, ctx.config.publicUrl);
      const result = await oidc.callback(current);
      if (result.mode === "handoff") {
        return reply.code(200).type("text/html; charset=utf-8").send(HANDOFF_PAGE);
      }
      ctx.auth.setDeviceCookie(reply, result.credential);
      return reply.redirect(result.next, 302);
    } catch (err) {
      return redirectError(ctx, req, reply, err);
    }
  });

  /** Not rate limited: the poll token is a 256-bit secret and the PWA polls every 2 s. */
  app.post("/api/auth/oidc/claim", async (req, reply) => {
    const oidc = requireOidc(ctx);
    const body = parse(OidcClaimRequest, req.body);
    const r = oidc.claim(body.flowId, body.pollToken);
    if (r.status === "pending") return { status: "pending" };
    ctx.auth.setDeviceCookie(reply, r.credential);
    return { status: "done", deviceId: r.deviceId };
  });

  // ---- authenticated: sign-in methods ------------------------------------------------------

  app.get("/api/auth/methods", async (): Promise<AuthMethods> => {
    const availability = ctx.owner.passkeyAvailability();
    return {
      passkeys: ctx.passkeys.list(),
      passkeyAvailability: { available: availability.available, reason: availability.reason },
      oidc: ctx.oidc ? await ctx.oidc.describe() : null,
    };
  });

  app.post("/api/auth/passkeys/register/options", async () => ctx.passkeys.registerOptions());

  app.post("/api/auth/passkeys/register/verify", async (req, reply) => {
    const body = parse(PasskeyRegisterVerifyRequest, req.body);
    const passkey = await ctx.passkeys.registerVerify(body.challengeId, body.name, body.response);
    return reply.code(201).send(passkey);
  });

  app.delete("/api/auth/passkeys/:id", async (req) => {
    ctx.passkeys.remove((req.params as { id: string }).id);
    return { ok: true };
  });

  // ---- admin: initialize the server ---------------------------------------------------------

  app.post("/api/admin/init", async (req): Promise<InitResponse> => {
    const device = deviceOf(req);
    if (!device.isAdmin || device.id !== ADMIN_DEVICE_ID) {
      throw new SwitchyardError("forbidden", "Only the server's local admin token can initialize");
    }
    const alreadyInitialized = !ctx.owner.markInitialized();
    const enrollment = await enrollmentResponse(ctx, "device", device.id);
    return { alreadyInitialized, enrollment };
  });
}

/** OIDC callback failures go back to the sign-in page with a code and readable detail. */
function redirectError(
  ctx: CoordinatorContext,
  req: FastifyRequest,
  reply: FastifyReply,
  err: unknown,
) {
  const code = err instanceof SwitchyardError ? err.code : "oidc_failed";
  const detail = err instanceof Error ? err.message : String(err);
  if (!(err instanceof SwitchyardError)) req.log.warn({ err }, "OIDC sign-in failed");
  else if (err.code === "forbidden") ctx.log.info({ detail }, "OIDC sign-in refused");
  const qs = new URLSearchParams({ error: code, detail });
  return reply.redirect(`/enroll?${qs.toString()}`, 302);
}
