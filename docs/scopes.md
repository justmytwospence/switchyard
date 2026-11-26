# Scopes and worktree rules

A scope is a named part of your work. Sessions and the Board can show one scope, and a herdr or tmux [client](clients.md) can mirror one. There are two kinds:

- **Projects you choose.** A set of projects (or every project), plus any session you pin. A scope can also hold only what you pin.
- **GitHub.** The scope has a GitHub **source**: the issues assigned to you in one owner, or every open issue on a Projects board. Its issues arrive on the Board, get a worktree and a session, and are cleaned up when they merge. GitHub keeps the scope's projects: the repositories the source covers.

A scope is not a permission: every signed-in client can open any session, whatever scope it shows.

```
Sources ──annotate──> Branch ──has──> Sessions <──select── Scopes <──shown by── Clients
(GitHub issues,       (project + branch,                   (named parts      (web app, phone,
 Projects boards)      its worktrees)                       of your work)     herdr, tmux)
```

Sources and clients never talk to each other; both meet at branches and sessions. See [model.md](model.md) for the whole model.

| Concept | What it is | Who owns the truth |
|---|---|---|
| Scope | A name, a mode (matching sessions plus pins, or pins only), projects, pins, and optionally a source | Switchyard |
| GitHub source | The host user's open assigned issues in one GitHub owner (optionally some repositories), plus repositories of other owners you add, optionally with a Projects board. With `--follow board`: every open issue on its Projects board, assigned or not | GitHub owns issues, assignees and board columns |
| Issue (tracked issue) | One open issue a source follows: its title, board priority, parent and sub-issue count, linked branches, pull request and board column, and the branch and worktree Switchyard works on | GitHub; Switchyard keeps a snapshot |
| Keep a session in every worktree (project setting) | Every non-main worktree gets one session when it first appears | Switchyard |
| Remove merged worktrees (project setting) | When a worktree's pull request has merged, archive its sessions and remove the worktree and its local branch | GitHub (PR state) and host git |

## What a scope holds

- A scope of projects you choose holds every session in those projects, plus the sessions you pin. In pinned mode it holds only the pins.
- A GitHub scope holds the sessions on branches linked to its issues, in any state, plus any session in its repositories that is live right now. A stopped session with no issue is not in it; it is under All sessions.
- A pin is membership only: it does not keep a session from being archived, and archiving removes it.
- A scope does not depend on where a session was started: a Pi you start by hand in any terminal belongs to the scopes that hold its project.

## What happens in a GitHub scope

1. **An issue is assigned to you** in the source's owner: it appears in the Board's Not started column, under the scope. With `--follow board` an issue appears once it is on the board and outside the backlog columns. Issues in repositories that have no project in Switchyard are counted in the scope's sync error, which names the repositories.
2. **Work starts** when the issue has a branch: a linked branch (the issue's Development sidebar, `gh issue develop`) or the head branch of an open pull request that closes it. **Start session** on the Board, or the issue chosen under Workspace in New session, (or dragging the issue to Working) creates the linked branch (`<number>-<title>`) for you when the source's host has a checkout, or a local branch of that name otherwise, then makes its worktree and opens an idle session titled `#<number> <title>`. A branch that already exists gets its worktree on its own at the next sync, or the worktree you already have is linked. Worktrees are made on the project's default host when it has a checkout there, else on the source's host.
3. **The pull request opens**: the branch moves to In review on the Board. **It merges**: the branch moves to Merged, and with "Remove merged worktrees" on, about ten minutes later its sessions are archived and the worktree and local branch removed.
4. **The issue closes, is unassigned, leaves the board or returns to a backlog column with no branch or pull request**: it disappears from the scope. The branch, its worktree and its sessions stay.

**Link by hand.** When you already started work in a worktree, open its session's menu and choose **Link to issue…**: it lists the project's issues that have no branch yet. The branch becomes the issue's branch, so its sessions stay in the issue's scope, and with write-back the card moves to the `--on-start` column at the next sync. A main checkout cannot be linked; pin the session to the scope instead. **Unlink from #N** undoes a link GitHub does not know about. Once GitHub links a branch to the issue (its Development sidebar, or a pull request that closes it), GitHub's link is used.

Scopes create no tasks. Tasks are for automations ([spec.md](spec.md)).

## Setting up

A scope of projects you choose needs only a name:

```sh
switchyard scopes create scratch --mode pinned
switchyard scopes create apps --project web --project api
```

A GitHub source uses a host's `gh` login, like the rest of [GitHub](github.md). For a Projects board, the login also needs the project permission: `gh auth refresh -h github.com -s project`. The source's host is only where `gh` runs; work happens on each project's default host.

1. Add the repositories as projects (Settings > Projects) on the hosts that will run the work, and turn on the two project settings if you want them.
2. Create the scope in Settings > Scopes (New scope, then GitHub issues), or with the CLI:

   ```sh
   switchyard scopes create work --github-host laptop --owner acme
   switchyard scopes create customers --github-host laptop --owner acme-customers \
     --board 3 --on-start "In progress" --on-review "In review" --write-back
   ```

   `--repo owner/name` (repeatable) limits it to some repositories. `--status-field` names the board's status field (default `Status`). `--also owner/name` (repeatable) adds a repository of another owner, for work that lives outside the organization: its project joins the scope and your assigned issues there are tracked too. An issue belongs to one scope, so do not cover the same repository with two GitHub scopes.
3. `switchyard scopes sync <name>` syncs now; otherwise every GitHub scope syncs every two minutes. `switchyard scopes list` shows the last sync and error.

`switchyard scopes edit <name>` changes either part. On a scope of projects you choose, `--github-host` with `--owner` adds a source (in the web app: Edit, then GitHub issues); `--no-github` removes one: its issues leave the Board and the scope keeps its current projects as your own list.

### Following a board

For a personal board where issues are triaged by column and not assigned, follow the board instead of your assignments:

```sh
switchyard scopes create personal --github-host server --owner your-login \
  --board 4 --follow board --backlog Backlog --priority-field Priority \
  --on-start "In progress" --on-review "In review" --write-back
```

- `--follow board` tracks every open issue on the board, whoever is assigned; `--follow assigned` (the default) tracks issues assigned to you. It needs `--board`.
- `--backlog <column>` (repeatable; `--no-backlog` on edit) names columns whose cards are not tracked until GitHub shows a branch or closing pull request for them, so a long backlog stays out of Not started. Move an issue to Ready (or any other column) to plan it.
- `--priority-field <name>` (`--no-priority-field` on edit) names a single-select field such as Priority. Its first option is the highest: not-started issues are listed by it on the Board, in New session and in Link to issue, and cards show it. A board without the field just has no priority.
- Sub-issues: a sub-issue's card says "Part of #N" and a parent shows "N/M sub-issues"; a parent stays an ordinary issue you can start.
- GitHub's own project workflows (new items to Backlog, merged pull requests to Done, auto-archive) keep working; Switchyard moves a card at most once per column.

### In the web app

Settings > Scopes shows each scope as a card: what it contains, where it is mirrored, and links that select it on Sessions or the Board.

- A GitHub scope adds its owner and repositories, the host and GitHub user, the board and how it moves cards, the last sync with the issue count and any error. Under Projects it lists the projects it covers, each with the two worktree switches. **Sync now** syncs at once.
- **Delete** removes the scope; for a GitHub scope, also its issues.

**New scope** and **Edit** open one form: a name and what the scope contains (projects you choose, pins only, or GitHub issues). Choosing GitHub issues on an existing scope connects it; choosing another option on a GitHub scope disconnects it, which removes its issues from the Board and keeps the scope. The scope selector on Sessions and the Board marks a GitHub scope, such as `work · GitHub`; the pencil beside it opens the same form, and the Sessions menu ends with "New scope…". With a GitHub scope selected, the Board can show the Projects board's own columns instead of stages. Deleting a scope does not touch its sessions; clients that mirrored it mirror nothing until you bind them again.

## Watching only

When something else already starts and finishes your work (for example pi-issues' `issue` tool, which links a branch, makes the worktree and sets the board status, and herdr's worktree-reaper, which removes merged worktrees), let Switchyard watch instead of act, so two tools never move the same card or remove the same worktree:

- create the scope without `--write-back` and with `--no-worktrees` (or `switchyard scopes edit <name> --no-write-back --no-worktrees`), so it neither moves cards nor makes a worktree for an issue branch that has none;
- leave "Keep a session in every worktree" and "Remove merged worktrees" off for its projects;
- start work your usual way. The Pi you start is adopted ([terminal-sessions.md](terminal-sessions.md#sessions-you-start-yourself)), its worktree is found, and a branch GitHub links to an issue shows that issue, its pull request and its board column.

Start session on the Board still works when you want it.

## Board write-back

With `--write-back`, Switchyard moves a card to the `--on-start` column once its worktree exists, and to the `--on-review` column once a pull request is open, at most once per column, so a card you move back stays where you put it. On the Board, with the scope's board columns shown, you can also drag a card to another column. Every move is checked on the host first, and skipped when:

- the card is assigned to someone else and not to the source's user (following a board, a card assigned to nobody is moved);
- someone else is assigned too and `--no-move-shared` is set (shared cards move by default);
- the card is no longer in the column Switchyard last saw (refresh and try again).

Only the status field is ever written. Draft items (not issues) are ignored.

## Limits

- Polling only (every two minutes); no webhooks. github.com only, and GitHub is the only source.
- At most 200 tracked issues per scope; following a board reads its first 500 open issues. Beyond that, nothing is removed until the list fits again.
- Following a board or backlog columns needs a host agent that supports it; an older one reports an error on the scope.
- Board columns are not stages: stages (Not started, Working, In review, Merged) come from the branch and its pull request.
- Landed means: the pull request is merged, the worktree's HEAD is the merged head, the tree is clean, and no session is running, for ten minutes. A squash-merged branch with local commits added afterwards is kept.
- With `gh` missing or signed out, a scope reports the error and nothing else changes.

## From 0.20

Until 0.20 a scope was two things: a **view** (the filter) and a **tracker** (the GitHub side), which kept a view of its own name. They are one thing now.

- Every view is a scope. A tracker and its view became one GitHub scope, with the view's name, mode and pins. It has the tracker's id, so nothing is re-synced and no card moves twice.
- `switchyard views`, `switchyard trackers` and `--view` still work and print a notice; they will be removed. `trackers create --host` is `scopes create --github-host` (in `scopes`, `--host` limits a scope to a host, as it did in `views`). `trackers delete` removed the tracker and kept its view: that is `scopes edit <name> --no-github` now, and `scopes delete` removes the scope.
- Settings > Trackers is Settings > Scopes, and lists every scope.
- A browser that had a tracker's view selected shows All sessions once; select the scope again.
- The upgrade is one-way: back up the coordinator first ([operations.md](operations.md#upgrading)).
