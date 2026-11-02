import { createHash, generateKeyPairSync, type KeyObject, randomBytes, sign } from "node:crypto";
import { isoCBOR } from "@simplewebauthn/server/helpers";
import { afterEach, describe, expect, it } from "vitest";
import { Owner } from "../src/index.js";
import { startCoordinator, type TestCoordinator } from "./helpers.js";

let t: TestCoordinator;
afterEach(async () => {
  await t?.cleanup();
});

const b64url = (b: Uint8Array | Buffer | string) => Buffer.from(b).toString("base64url");
const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest();
const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};

/** A software ES256 authenticator: attestation "none" and assertions built by hand. */
class SoftAuthenticator {
  readonly credentialId = randomBytes(16);
  private readonly privateKey: KeyObject;
  private readonly x: Buffer;
  private readonly y: Buffer;
  userHandle: string | null = null;

  constructor(
    readonly rpId: string,
    readonly origin: string,
  ) {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.privateKey = privateKey;
    const jwk = publicKey.export({ format: "jwk" });
    this.x = Buffer.from(jwk.x!, "base64url");
    this.y = Buffer.from(jwk.y!, "base64url");
  }

  get id(): string {
    return b64url(this.credentialId);
  }

  register(options: { challenge: string; user: { id: string } }) {
    this.userHandle = options.user.id;
    const cose = isoCBOR.encode(
      new Map<number, number | Uint8Array>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, new Uint8Array(this.x)],
        [-3, new Uint8Array(this.y)],
      ]),
    );
    const idLen = Buffer.alloc(2);
    idLen.writeUInt16BE(this.credentialId.length);
    const authData = Buffer.concat([
      sha256(this.rpId),
      Buffer.from([0x45]), // UP | UV | AT
      u32(0),
      Buffer.alloc(16), // AAGUID
      idLen,
      this.credentialId,
      Buffer.from(cose),
    ]);
    const attestationObject = isoCBOR.encode(
      new Map<string, string | Map<string, never> | Uint8Array>([
        ["fmt", "none"],
        ["attStmt", new Map()],
        ["authData", new Uint8Array(authData)],
      ]),
    );
    const clientDataJSON = JSON.stringify({
      type: "webauthn.create",
      challenge: options.challenge,
      origin: this.origin,
      crossOrigin: false,
    });
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      response: {
        clientDataJSON: b64url(clientDataJSON),
        attestationObject: b64url(attestationObject),
        transports: ["internal"],
      },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  }

  assert(options: { challenge: string }, counter: number, credentialId = this.credentialId) {
    const authData = Buffer.concat([sha256(this.rpId), Buffer.from([0x05]), u32(counter)]);
    const clientDataJSON = Buffer.from(
      JSON.stringify({ type: "webauthn.get", challenge: options.challenge, origin: this.origin }),
    );
    const signature = sign(
      "sha256",
      Buffer.concat([authData, sha256(clientDataJSON)]),
      this.privateKey,
    );
    const id = b64url(credentialId);
    return {
      id,
      rawId: id,
      type: "public-key",
      response: {
        authenticatorData: b64url(authData),
        clientDataJSON: b64url(clientDataJSON),
        signature: b64url(signature),
        userHandle: this.userHandle ?? undefined,
      },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  }
}

async function registerPasskey(name = "MacBook") {
  const auth = new SoftAuthenticator("localhost", t.c.config.publicUrl);
  const opts = await t.admin("POST", "/api/auth/passkeys/register/options");
  expect(opts.status).toBe(200);
  expect(opts.body.options.rp.id).toBe("localhost");
  expect(opts.body.options.authenticatorSelection).toMatchObject({
    residentKey: "required",
    userVerification: "preferred",
  });
  const verify = await t.admin("POST", "/api/auth/passkeys/register/verify", {
    challengeId: opts.body.challengeId,
    name,
    response: auth.register(opts.body.options),
  });
  expect(verify.status).toBe(201);
  return { auth, passkey: verify.body };
}

async function signIn(auth: SoftAuthenticator, counter: number, credentialId?: Buffer) {
  const opts = await t.api("POST", "/api/auth/passkey/options");
  expect(opts.status).toBe(200);
  expect(opts.body.options.allowCredentials ?? []).toEqual([]);
  return t.api("POST", "/api/auth/passkey/verify", {
    body: {
      challengeId: opts.body.challengeId,
      response: auth.assert(opts.body.options, counter, credentialId),
      deviceName: "Phone",
      kind: "pwa",
    },
  });
}

function storedCounter(id: string): number {
  return (
    t.c.store.db.prepare("SELECT counter FROM passkeys WHERE id = ?").get(id) as {
      counter: number;
    }
  ).counter;
}

describe("passkey availability", () => {
  it("needs a domain name and HTTPS, with localhost excepted", async () => {
    t = await startCoordinator();
    const at = (publicUrl: string) =>
      new Owner(t.c.store, { ...t.c.config, publicUrl }).passkeyAvailability();
    expect(at("http://192.168.1.5:7400")).toEqual({
      available: false,
      reason: "Passkeys need a domain name (or localhost) in the public URL",
    });
    expect(at("https://[::1]:7400").reason).toBe(
      "Passkeys need a domain name (or localhost) in the public URL",
    );
    expect(at("http://sy.example.com")).toEqual({
      available: false,
      reason: "Passkeys need HTTPS",
    });
    expect(at("http://localhost:7400")).toEqual({ available: true, reason: null });
    expect(at("https://sy.example.com")).toEqual({ available: true, reason: null });
  });

  it("refuses registration with the reason when unavailable", async () => {
    t = await startCoordinator({ publicUrl: "http://127.0.0.1:7400" });
    const r = await t.admin("POST", "/api/auth/passkeys/register/options");
    expect(r.status).toBe(409);
    expect(r.body.error).toMatchObject({
      code: "unsupported_capability",
      message: "Passkeys need a domain name (or localhost) in the public URL",
    });
  });
});

describe("passkeys", () => {
  it("registers a passkey and signs in with it, minting a passkey device", async () => {
    t = await startCoordinator();
    const none = await t.api("POST", "/api/auth/passkey/options");
    expect(none.status).toBe(409);
    expect(none.body.error.message).toBe("No passkey is registered on this server yet");

    const { auth, passkey } = await registerPasskey();
    expect(passkey).toMatchObject({
      id: auth.id,
      name: "MacBook",
      lastUsedAt: null,
      transports: ["internal"],
    });
    expect((await t.api("GET", "/api/setup")).body.passkey.registered).toBe(true);

    const r = await signIn(auth, 1);
    expect(r.status).toBe(201);
    expect(r.body.credential).toBe("");
    const cookie = r.headers.get("set-cookie")!;
    expect(cookie).toMatch(/^sy_device=/);
    const me = await t.api("GET", "/api/me", { cookie: cookie.split(";")[0]! });
    expect(me.status).toBe(200);
    expect(me.body.device).toMatchObject({
      id: r.body.deviceId,
      name: "Phone",
      kind: "pwa",
      enrolledVia: "passkey",
    });

    const methods = await t.admin("GET", "/api/auth/methods");
    expect(methods.body.passkeys).toHaveLength(1);
    expect(methods.body.passkeys[0].lastUsedAt).not.toBeNull();
    expect(methods.body.passkeyAvailability).toEqual({ available: true, reason: null });
    expect(methods.body.oidc).toBeNull();
  });

  it("updates the signature counter and rejects a counter that goes backwards", async () => {
    t = await startCoordinator();
    const { auth } = await registerPasskey();
    expect(storedCounter(auth.id)).toBe(0);
    expect((await signIn(auth, 5)).status).toBe(201);
    expect(storedCounter(auth.id)).toBe(5);
    expect((await signIn(auth, 9)).status).toBe(201);
    expect(storedCounter(auth.id)).toBe(9);
    const replay = await signIn(auth, 3);
    expect(replay.status).toBe(401);
    expect(storedCounter(auth.id)).toBe(9);
  });

  it("rejects an unknown credential with 401", async () => {
    t = await startCoordinator();
    const { auth } = await registerPasskey();
    const r = await signIn(auth, 1, randomBytes(16));
    expect(r.status).toBe(401);
    expect(r.body.error.message).toBe("This passkey is not registered here");
  });

  it("rejects expired or reused challenges with invalid_request", async () => {
    t = await startCoordinator();
    const { auth } = await registerPasskey();
    const opts = await t.api("POST", "/api/auth/passkey/options");
    t.clock.advance(5 * 60_000 + 1000);
    const late = await t.api("POST", "/api/auth/passkey/verify", {
      body: {
        challengeId: opts.body.challengeId,
        response: auth.assert(opts.body.options, 1),
        deviceName: "Phone",
        kind: "browser",
      },
    });
    expect(late.status).toBe(400);
    expect(late.body.error).toEqual({
      code: "invalid_request",
      message: "This passkey request expired; try again",
    });

    const reg = await t.admin("POST", "/api/auth/passkeys/register/options");
    const other = new SoftAuthenticator("localhost", t.c.config.publicUrl);
    const body = {
      challengeId: reg.body.challengeId,
      name: "Second",
      response: other.register(reg.body.options),
    };
    expect((await t.admin("POST", "/api/auth/passkeys/register/verify", body)).status).toBe(201);
    const reused = await t.admin("POST", "/api/auth/passkeys/register/verify", body);
    expect(reused.status).toBe(400);
    expect(reused.body.error.message).toBe("This passkey request expired; try again");
  });

  it("rejects an assertion from another origin", async () => {
    t = await startCoordinator();
    const { auth } = await registerPasskey();
    const evil = Object.assign(Object.create(Object.getPrototypeOf(auth)), auth, {
      origin: "https://evil.example",
    }) as SoftAuthenticator;
    const r = await signIn(evil, 1);
    expect(r.status).toBe(401);
  });

  it("excludes registered credentials and removes passkeys", async () => {
    t = await startCoordinator();
    const { auth } = await registerPasskey();
    const opts = await t.admin("POST", "/api/auth/passkeys/register/options");
    expect(opts.body.options.excludeCredentials.map((c: { id: string }) => c.id)).toEqual([
      auth.id,
    ]);
    // Registration needs a device; sign-in routes are public.
    expect((await t.api("POST", "/api/auth/passkeys/register/options")).status).toBe(401);
    expect((await t.admin("DELETE", `/api/auth/passkeys/${auth.id}`)).status).toBe(200);
    expect((await t.admin("DELETE", `/api/auth/passkeys/${auth.id}`)).status).toBe(404);
    expect((await t.admin("GET", "/api/auth/methods")).body.passkeys).toEqual([]);
  });
});
