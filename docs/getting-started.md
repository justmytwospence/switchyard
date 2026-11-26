# Getting started

From nothing to an agent you can answer from your phone, in five steps. Each step links to the guide with every option.

You need Node 24 or newer, git, and [Pi](https://github.com/earendil-works/pi) 1.4 or 1.5 on your `PATH`, signed in to a model provider, on macOS or Linux.

## 1. Install and start

```sh
npm install -g @spencerboucher/switchyard
switchyard up
```

`up` runs the coordinator and a host in one process at `http://localhost:7400`. On first start it prints a single-use sign-in link with a QR code and opens it in your browser. Lost the link? `switchyard pair` prints a new one. See [Local: `switchyard up`](deployment.md#local-switchyard-up).

## 2. Your first host

With `up`, this machine is already your first host: it is enrolled on first start and shows in Settings › Hosts. Pi runs as you, with your repositories, worktrees and model logins.

Later, to run agents on more machines, run the coordinator as a server and enroll each machine as a host with the three commands Settings › Hosts › Add host shows. See [A server](deployment.md#a-server) and [Hosts](deployment.md#hosts).

## 3. Your first session

1. In Settings › Projects, add a project: the path of a git repository on the host.
2. On Sessions, choose **New session**, pick the project and a branch, and write what you want done. A new branch gets its own git worktree inside the repository (`<repo>/.worktrees/<branch>`).
3. Watch it work. When Pi or a plugin asks a question, it shows as a card; answer it there.

Sessions, branches, scopes and the Board are explained in [the model](model.md). To bring in the GitHub issues assigned to you, add a [GitHub scope](scopes.md).

## 4. Your phone

A phone reaches the coordinator at a URL it can open, so a coordinator on `localhost` is not enough. Either:

- run `switchyard up --public-url <url>` with an address your phone reaches (a LAN or VPN address), or
- run the coordinator as a server behind HTTPS, for example with `tailscale serve` ([VPN or tailnet](deployment.md#vpn-or-tailnet)).

Then sign the phone in: open a fresh `switchyard pair` link on it, or use single sign-on ([sign-in and devices](auth.md)). Over HTTPS you can add Switchyard to the Home Screen and turn on notifications in Settings › Notifications, so questions reach you as they are asked ([iOS Home Screen push](deployment.md#ios-home-screen-push)).

## 5. Your terminal and herdr

A session Switchyard starts runs Pi's own TUI in a holder on its host (a terminal session). Sign a terminal in once, then open any of them in it:

```sh
switchyard login --coordinator http://localhost:7400
switchyard tui <session id>       # Ctrl+] detaches; the session keeps running
```

With the herdr plugin linked (`herdr plugin link <repo>/modules/herdr`), every herdr session is a Switchyard **client**: Pi you start in it by hand shows up in Switchyard, and the session mirrors nothing until you choose. Bind it to everything or to one scope with `switchyard clients bind herdr:<session> --all` (or `--scope <name>`), or in Settings › Clients, and it shows a space per workspace and a tab per active branch, in sync with the web app. tmux works the same way. See [clients](clients.md), [terminal sessions](terminal-sessions.md) and the [herdr](../modules/herdr/README.md) and [tmux](../modules/tmux/README.md) client modules.

## Next

- [The model](model.md): what work it is, where it runs, where you look at it.
- [Deployment](deployment.md): an always-on server, reverse proxies, every setting.
- [CLI](cli.md): every `switchyard` command.
