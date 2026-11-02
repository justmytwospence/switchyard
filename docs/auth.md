# Sign-in, devices and hosts

Switchyard has one owner. Every browser, phone and terminal that uses it is a **device** with its own revocable credential, and every machine that runs Pi is a **host** with its own credential. This page explains how a server becomes owned, how devices and hosts get in, and how to revoke them. It assumes nothing about your network or identity provider; [deployment.md](deployment.md) covers the network side.

## The owner model

- A server is **owned before it serves anything**. There is no "unclaimed" state in which the first visitor can take it over.
- Ownership is created by someone who already controls the server, in one of three ways:
  1. `switchyard init` on the server (below).
  2. Declaring an owner in the server's configuration: setting the `SWITCHYARD_OIDC_*` variables (see [Single sign-on](#single-sign-on-oidc)) makes the server owned at start.
  3. `switchyard up` on your own machine, which does the equivalent of `init` for you.
- Everything after that is started by the owner: pairing a device, adding a passkey, enrolling a host. A visitor cannot ask for access or be approved; an unauthenticated visitor sees a sign-in page and nothing else.
- A request is authenticated by a **device credential** issued by the coordinator (an HttpOnly cookie in browsers, a bearer token in the terminal client). Passkeys and single sign-on do not authenticate requests themselves: they prove who you are once and mint a normal device. An expired provider session therefore never breaks an installed app, push notifications or a WebSocket.

### Why there is no "unclaimed" state

A page that says "this server has no owner, claim it" announces to the network that the server is up for grabs, and whoever reaches it first wins. A claim code shown to visitors has the same flaw. Switchyard instead requires server access to create the owner, so ownership never depends on who can reach the URL first, and it works the same on a LAN, a VPN or the open internet. Before a server is set up, visitors only see "Switchyard isn't set up yet" with the command to run on the server.

### Bootstrap: `switchyard init`

Run it on the machine that runs the coordinator. It authenticates with the local admin token (`admin.token` in the data dir) and prints a single-use sign-in link and QR code for your first device:

```
switchyard init
docker exec switchyard switchyard init       # the container image; `switchyard` is on PATH
docker compose exec switchyard switchyard init
```

The link expires after 10 minutes. Open it on your first device. Running `init` again on an already set up server prints a fresh single-use link (`Already set up. New single-use sign-in link for one device`). Add `--json` for scripting; `--coordinator <url>` and `--data-dir <dir>` select a running coordinator or data dir when the defaults do not find it. In the image the data dir is `/data` through `SWITCHYARD_DATA_DIR`, so no flags are needed.

Until the server is set up, the coordinator prints "Switchyard is not set up yet. Run `switchyard init` on this server" at start and logs the same hint. It mints no enrollment on its own.

`switchyard up` (local use) sets the server up in the same way on first start, prints the link and QR code, and opens the link in your browser when run in an interactive terminal (`--no-open` to prevent it, `--open` to force it).

A server upgraded from a version that already had devices counts as set up.

## Pairing more devices

Pairing is always started by a signed-in owner:

- **Settings › Devices › Add device** shows a QR code and link. Scan it with the new device's camera or open the link there. It is single use and expires after 10 minutes.
- **`switchyard pair`** prints the same link and QR code on the server, using the admin token. It also prints a `switchyard login` command for a terminal client.
- **A passkey or single sign-on** (below) lets a device sign in without a link.

A link carries a URL and a one-time token, not network access: the new device must already be able to reach the server's URL.

Terminal clients enroll with `switchyard login --coordinator <url> --token <token or link>`; see [deployment.md](deployment.md#terminal-client).

### Recovery: lost every device

Run `switchyard pair` (or `switchyard init`) on the server for a fresh link. Server access is the recovery path, which is why the admin token must be protected. With single sign-on configured you can also simply sign in again.

## Passkeys

A passkey lets the owner sign in on any device with a fingerprint, face or screen lock, with no identity provider. Signing in with one mints a new device like a pairing link does.

1. Sign in once with a link (or single sign-on).
2. Open **Settings › Sign-in › Add a passkey**, name it and approve the prompt.
3. From then on the sign-in page offers "Sign in with a passkey".

Requirements, checked from the public URL (`SWITCHYARD_PUBLIC_URL`):

- The URL must be **HTTPS**, or the host must be `localhost`. Plain HTTP on any other name is refused ("Passkeys need HTTPS").
- The host must be a **domain name**, not an IP address ("Passkeys need a domain name (or localhost) in the public URL"). WebAuthn binds a passkey to a name.

Settings › Sign-in and the sign-in page show the reason when passkeys are unavailable. Other things to know:

- The passkey is bound to the public URL's host name (the WebAuthn relying party ID). If you move the server to a different host name, existing passkeys stop working; register new ones. A passkey made for `localhost` works only at `localhost`.
- Each browser origin you use must be a trusted origin (`SWITCHYARD_TRUSTED_ORIGINS`, default the public URL's origin).
- Switchyard stores only the public key. Remove a passkey under Settings › Sign-in; devices already signed in with it stay signed in until revoked.
- Credentials are discoverable (resident) and user verification is "preferred", so platform authenticators, password managers and security keys work.

## Single sign-on (OIDC)

Any OpenID Connect provider can sign the owner in: Authelia, Authentik, Keycloak, Pocket ID, Google and others. Switchyard uses the authorization code flow with PKCE (S256), `state` and `nonce`. The server refuses to start unless an owner match is configured.

Setting `SWITCHYARD_OIDC_ISSUER` and `SWITCHYARD_OIDC_CLIENT_ID` enables it. Setting only one of the two is an error. These variables are read by `switchyard coordinator start`, which is what the container image runs, and by `switchyard up`.

| Variable | Default | Meaning |
|---|---|---|
| `SWITCHYARD_OIDC_ISSUER` | (required) | The provider's issuer URL. Switchyard fetches `<issuer>/.well-known/openid-configuration`. Must be HTTPS (plain HTTP only for `localhost`, `127.0.0.1` and `::1`). |
| `SWITCHYARD_OIDC_CLIENT_ID` | (required) | The client ID registered at the provider. |
| `SWITCHYARD_OIDC_CLIENT_SECRET` | none | The client secret. Without one, Switchyard acts as a public client (PKCE only); a confidential client is recommended. The secret is sent with HTTP Basic (`client_secret_basic`). |
| `SWITCHYARD_OIDC_LABEL` | `Sign in with single sign-on` | The button text on the sign-in page. |
| `SWITCHYARD_OIDC_SCOPES` | `openid profile email groups` | Space-separated scopes requested. |
| `SWITCHYARD_OIDC_OWNER_SUBJECT` | none | The owner's `sub` claim. |
| `SWITCHYARD_OIDC_OWNER_EMAIL` | none | The owner's email, compared case-insensitively. The provider must not say `email_verified: false`. |
| `SWITCHYARD_OIDC_OWNER_GROUP` | none | A group (the `groups` claim must be a list containing it). |

**Owner match.** Set at least one of the three `OWNER_*` variables. When several are set, **all** must hold. Whoever matches is the owner and gets full access, so prefer a specific criterion (the subject, or your email) over a group that others belong to. A user who signs in successfully at the provider but does not match is refused with "Signed in as ... which is not this server's owner", naming the subject so you can copy it into `SWITCHYARD_OIDC_OWNER_SUBJECT`.

**Claims.** The ID token and the provider's userinfo endpoint are merged, because some providers (Authelia, for one) return `email` and `groups` only from userinfo. Make sure the `email` and `groups` scopes are granted if you match on them.

**Redirect URI.** Register exactly `<public URL>/api/auth/oidc/callback`, for example `https://switchyard.example.com/api/auth/oidc/callback`. It is built from `SWITCHYARD_PUBLIC_URL`, never from request headers, so it must match what you register character for character.

A provider that is down at start does not stop the server. It is retried after 30 seconds, and Settings › Sign-in shows the status ("ready" or the error).

### Provider notes

Register Switchyard as a **confidential** client (it has a client secret), authorization code grant, PKCE method **S256**, token endpoint authentication **client_secret_basic**, scopes `openid profile email groups`. Exact field names vary by provider and version; these notes show where to look and were not checked against every release.

- **Authelia.** Add a client under `identity_providers.oidc.clients` with `public: false`, an `authorization_policy`, `redirect_uris` set to the callback URL, `scopes: [openid, profile, email, groups]`, `require_pkce: true`, `pkce_challenge_method: S256` and `token_endpoint_auth_method: client_secret_basic`. Authelia stores a hash of the secret (`authelia crypto hash generate pbkdf2 ...`); Switchyard gets the plaintext in `SWITCHYARD_OIDC_CLIENT_SECRET`. Authelia returns `email` and `groups` from userinfo, which Switchyard merges. The issuer is Authelia's base URL.
- **Authentik.** Create an OAuth2/OpenID Provider and an Application, client type Confidential, with the callback as a strict redirect URI. The issuer is `https://<authentik>/application/o/<application slug>/`. Include the `openid`, `profile` and `email` scope mappings; the `groups` claim comes with the default profile mapping.
- **Keycloak.** Create a client with Client authentication on and the Standard flow enabled, valid redirect URI set to the callback, and "Proof Key for Code Exchange Code Challenge Method" set to S256 under Advanced settings. The issuer is `https://<keycloak>/realms/<realm>`. To match on a group, add a Group Membership mapper to the client's scope and turn "Full group path" off so the claim holds `admins` rather than `/admins`.
- **Pocket ID.** Create an OIDC client with the callback URL, keep it a confidential (not public) client with PKCE enabled, and copy its client ID and secret. The issuer is Pocket ID's base URL. Use the `groups` scope if you match on a group.

### Installed apps (PWA)

A web app installed to the Home Screen (iOS in particular) has its own cookie jar, separate from the browser. A normal redirect to the provider would finish in the browser, not in the app. So when Switchyard runs as an installed app, it:

1. starts the sign-in and opens the provider in the system browser,
2. shows "Finish signing in, then come back here",
3. after you approve at the provider, the browser shows "Signed in. Return to the Switchyard app to continue." (it does not receive the credential),
4. the app claims the new device with a one-time poll token, checking every 2 seconds while visible and when you return to it, for up to 10 minutes.

In an ordinary browser tab the flow is a direct redirect. Passkeys work directly inside an installed app. A pairing link opens in the browser, not in the installed app, so sign in to the installed app with a passkey or single sign-on.

## Hosts

A host is a machine running the host agent, which owns the Pi processes, repositories and provider credentials. Hosts connect outbound to the coordinator and authenticate with their own credential in `host.json` (mode 0600, default `~/.config/switchyard/host.json`, or `SWITCHYARD_HOST_CONFIG`).

### Enrolling with a single-use token

1. In **Settings › Hosts › Add host** (or `switchyard pair --host` on the server) create a host enrollment. It is single use and expires after 30 minutes.
2. On the host, as the user that should run Pi, run the command it shows:

   ```
   switchyard host enroll --coordinator https://switchyard.example.com --token <token> [--name my-laptop]
   ```

3. Start the agent with `switchyard host run`, or install it as a service ([deployment.md](deployment.md#hosts)).

### Enrolling with a shared secret

For hosts that should enroll themselves (containers, provisioned machines), set a secret on the server and the same secret on the host. This is opt-in: without `SWITCHYARD_HOST_ENROLL_SECRET` on the coordinator, secret enrollment is refused.

On the coordinator (at least 32 characters; the server refuses to start with a shorter one; generate one with `openssl rand -base64 48`):

```
SWITCHYARD_HOST_ENROLL_SECRET=<secret>
```

On each host:

```
SWITCHYARD_COORDINATOR_URL=https://switchyard.example.com
SWITCHYARD_HOST_ENROLL_SECRET=<secret>
SWITCHYARD_HOST_NAME=my-server        # optional; default: the machine's host name
switchyard host run
```

`host run` finds no `host.json`, enrolls with the secret, writes it, and continues. You can also enroll once by hand: `switchyard host enroll --coordinator <url> --secret <secret>`. Each host the secret creates gets its own credential and is revocable on its own. Treat the secret like a password: anyone holding it can add a host that receives work. To stop accepting it, remove it from the coordinator's environment and restart; hosts already enrolled keep working.

### Hosts wait instead of crashing

A host agent without `host.json` never exits:

- With the secret and coordinator URL set, it enrolls itself, retrying every 5 seconds while the coordinator is unreachable ("Coordinator not reachable yet; retrying") and every minute after other errors (a wrong secret, secret enrollment not enabled).
- Otherwise it logs, every 10 minutes, "This host is not enrolled. Create a host token in Settings › Hosts › Add host, then run: switchyard host enroll ...", and checks every 5 seconds whether `host.json` has appeared, then connects.

So a host can be started before the server exists, and a service manager never sees a crash loop.

## Revocation

- **Devices:** Settings › Devices › Revoke. The credential stops working at once, the device's push subscriptions are deleted, and its open sockets are told to sign out. Signing out of one device (Settings › Sign-in) only clears its cookie.
- **Hosts:** Settings › Hosts, open the host, Revoke. Its credential stops working and its link is dropped. A host that enrolled with the shared secret is revoked individually; if you want it gone for good, also remove the secret or delete its `host.json`, since a host without `host.json` enrolls again while the secret is set.
- **Passkeys:** Settings › Sign-in › Remove. Devices already minted by the passkey are unaffected; revoke them separately.
- **The local admin token** (`admin.token` in the data dir) cannot be revoked from the app. Rotate it by stopping the coordinator, deleting the file and starting again.

## Rate limits

Public sign-in endpoints have a small in-process limit per client IP, in a fixed one-minute window, answering `429 rate_limited` ("Too many attempts; wait a minute and try again"):

| Group | Limit | Routes |
|---|---|---|
| auth | 20 per minute | `/api/enroll`, `/api/auth/passkey/options`, `/api/auth/passkey/verify`, `/api/auth/oidc/begin`, `/api/auth/oidc/callback` |
| hosts | 10 per minute | `/api/hosts/enroll` |

The counters live in memory and reset on restart. The single-use tokens and the one-time OIDC poll token are 256-bit secrets, so the limits mostly guard the passkey, provider and shared-secret paths.

## Trusted proxies

Limits are keyed by client IP. By default Switchyard uses the socket address and ignores `X-Forwarded-For`, so a client cannot spoof its address. Behind a reverse proxy every request then comes from the proxy, and all clients share one bucket. Set `SWITCHYARD_TRUSTED_PROXIES` to a comma-separated list of the proxy's IPs or CIDRs (for example `127.0.0.1` or a Docker network subnet such as `172.18.0.0/16`) and Switchyard will take the client address from `X-Forwarded-For` only on connections from those addresses.

Forwarded headers are never used for anything else. The `Secure` cookie flag and the trusted origins come from `SWITCHYARD_PUBLIC_URL` and `SWITCHYARD_TRUSTED_ORIGINS`, so configure those to match the URL people use.
