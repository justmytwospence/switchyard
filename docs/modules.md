# Modules

Switchyard's core knows four kinds of thing that come in more than one variety. A **module** is the code that adds one variety.

| Family | The question it answers | Built in | Where its modules run |
|---|---|---|---|
| Host | Where does the work run? | A machine running the host agent | On that machine |
| Client | Where do you look at it? | The web app, the phone and the CLI; herdr and tmux as client modules | On the client's machine, signed in as a device |
| Scope | What work is it? | Projects you choose; GitHub issues and Projects boards | On a host, with that host's `gh` login |
| Trigger | What starts unattended work? | Cron, once, webhook, and another task finishing | Wherever the caller is: a trigger is an HTTP request or a schedule |

Hosts, [clients](clients.md) and [scopes](scopes.md) are in [the model](model.md); triggers start automations ([spec.md](spec.md)).

## Module, plugin, adapter

Three words, one rule each:

- A **module** plugs into Switchyard. It adds a kind of host, client, scope or trigger.
- A **plugin** plugs into another program: a Pi plugin, a herdr plugin, a tmux plugin. Switchyard has no plugins of its own. A module can contain one: the herdr client module is a herdr plugin (`modules/herdr`) plus a daemon in the Switchyard CLI.
- An **adapter** translates between one Pi plugin and Switchyard: it turns that plugin's dialogs and state into portable UI ([adapters.md](adapters.md)). The plugin owns it.

What belongs to core and what to each of these is the [ownership contract](plugin-boundaries.md).

## Where modules run

The coordinator never runs code: it keeps state, decides what runs where and relays. So a module is never loaded into it. A module is a process somewhere else that speaks one of the coordinator's contracts, with its own revocable credential:

- a client module runs on the machine it shows things on and signs in as a device (`switchyard login`);
- the GitHub scope module runs `gh` on a host, under that host's credential and GitHub login; the separate repository catalog worker holds GitHub App credentials in the coordinator data directory;
- a trigger module is whatever sends the request: another service, a CI job, a cron line.

Core never branches on a kind's name. It records what a module reports and what you chose for it, and it asks about capabilities (a host's features, a client's capabilities in its hello), not about who is asking. With a module absent, everything else works: without the GitHub module a scope is projects you choose, and without a client module there is the web app.

## What another project can write today

**A trigger.** This contract is open and stable. Create an automation with a webhook trigger, and send `POST /api/hooks/<automationId>` with the automation's bearer token and a JSON body. The automation's filters match dot-paths of the body, and its task template substitutes `{{payload.<dot.path>}}`, so a service that already sends webhooks needs only a target URL and a token ([operations.md](operations.md#webhooks)). A retried delivery with the same `Idempotency-Key` is one occurrence.

**A client.** Nearly open. The herdr and tmux modules use nothing but the public API, and a module for another multiplexer can do the same:

1. sign in as a device (`switchyard login`, or the device enrollment API);
2. report each session it runs in with `PUT /api/clients/<kind>:<name>@<machine>` and a body of `kind`, `name`, `machine` and the sessions it `shows`; any lowercase `kind` is accepted;
3. read what the client mirrors from the synced state (`clients` and `scopes` over `/ws/client`, with the capability `scopes.v1`), never from its name;
4. show a session by running `switchyard tui <session>` in a pane, and open work with `POST /api/branches/open`.

What is not shared yet is the logic that decides which sessions a mirror opens (one tab per active branch): it lives in the CLI (`packages/cli/src/mirror`), not in the [client SDK](client-sdk.md).

**A host.** The host agent's protocol is the contract, and there is one implementation of it. Nothing yet lets a module create, wake or destroy a host on demand, which is what a sandbox or cloud host would need.

**A scope.** Not yet. GitHub is the only source, and its sync is split between the host agent (the `gh` calls) and the coordinator (matching issues to projects and branches, and board write-back), with GitHub's shapes in the protocol. A contract for scope sources waits for a second one to shape it.
