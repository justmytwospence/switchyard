import { createHash } from "node:crypto";
import { decodeJwt } from "jose";
import { afterEach, describe, expect, it } from "vitest";
import { type MockOidc, startMockOidc } from "../src/index.js";

let oidc: MockOidc | undefined;
afterEach(async () => {
  await oidc?.close();
  oidc = undefined;
});

async function codeFlow(issuer: string, verifier = "v".repeat(43)) {
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authorize = new URL(`${issuer}/authorize`);
  for (const [k, v] of Object.entries({
    response_type: "code",
    client_id: "sy",
    redirect_uri: "http://app.test/cb",
    state: "st",
    nonce: "nn",
    code_challenge: challenge,
    code_challenge_method: "S256",
  })) {
    authorize.searchParams.set(k, v);
  }
  const a = await fetch(authorize, { redirect: "manual" });
  expect(a.status).toBe(302);
  const back = new URL(a.headers.get("location")!);
  expect(back.origin + back.pathname).toBe("http://app.test/cb");
  expect(back.searchParams.get("state")).toBe("st");
  return fetch(`${issuer}/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Basic ${Buffer.from("sy:secret").toString("base64")}`,
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: back.searchParams.get("code")!,
      redirect_uri: "http://app.test/cb",
      code_verifier: verifier,
    }),
  });
}

describe("mock OIDC provider", () => {
  it("serves discovery and keeps email and groups in userinfo only by default", async () => {
    oidc = await startMockOidc({
      claims: { sub: "u1", email: "me@example.com", email_verified: true, groups: ["admins"] },
    });
    const meta = await (await fetch(`${oidc.issuer}/.well-known/openid-configuration`)).json();
    expect(meta.issuer).toBe(oidc.issuer);
    const tok = await codeFlow(oidc.issuer);
    expect(tok.status).toBe(200);
    const body = await tok.json();
    const id = decodeJwt(body.id_token);
    expect(id).toMatchObject({ sub: "u1", nonce: "nn", aud: "sy", iss: oidc.issuer });
    expect(id.email).toBeUndefined();
    const info = await (
      await fetch(`${oidc.issuer}/userinfo`, {
        headers: { authorization: `Bearer ${body.access_token}` },
      })
    ).json();
    expect(info).toMatchObject({ sub: "u1", email: "me@example.com", groups: ["admins"] });
    expect(oidc.tokenRequests[0]).toMatchObject({ clientId: "sy", auth: "client_secret_basic" });
  });

  it("puts every claim in the ID token with idTokenClaimsOnly", async () => {
    oidc = await startMockOidc({ claims: { sub: "u2", email: "x@y.z" }, idTokenClaimsOnly: true });
    const body = await (await codeFlow(oidc.issuer)).json();
    expect(decodeJwt(body.id_token).email).toBe("x@y.z");
  });

  it("rejects a wrong PKCE verifier", async () => {
    oidc = await startMockOidc({ claims: { sub: "u3" } });
    const challengeFor = "a".repeat(43);
    // Authorize with one verifier, redeem with another.
    const challenge = createHash("sha256").update(challengeFor).digest("base64url");
    const authorize = new URL(`${oidc.issuer}/authorize`);
    authorize.search = new URLSearchParams({
      response_type: "code",
      client_id: "sy",
      redirect_uri: "http://app.test/cb",
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString();
    const a = await fetch(authorize, { redirect: "manual" });
    const code = new URL(a.headers.get("location")!).searchParams.get("code")!;
    const tok = await fetch(`${oidc.issuer}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: "sy",
        redirect_uri: "http://app.test/cb",
        code_verifier: "b".repeat(43),
      }),
    });
    expect(tok.status).toBe(400);
  });
});
