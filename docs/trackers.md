# Trackers and worktree rules

A tracker connects Switchyard to the GitHub issues assigned to you, so that work arrives on the Board, gets a worktree and a session, and is cleaned up when it merges. It is one of three layers:

```
Trackers ──annotate──> Branch ──has──> Sessions <──query── Views <──shown on── Surfaces
(GitHub issues,        (project + branch,                  (saved           (browser, phone,
 GitHub Projects)       its worktrees)                      filters)         herdr, tmux)
```

Trackers and surfaces never talk to each other; both meet at branches and sessions. A view is a saved filter with one source: your own filters and pins, a tracker, or a terminal ([terminal-sessions.md](terminal-sessions.md#views-and-surfaces)). See [model.md](model.md) for the whole model.

| Concept | What it is | Who owns the truth |
|---|---|---|
| Tracker | The host user's open assigned issues in one GitHub owner (optionally some repositories), plus repositories of other owners you add, optionally with a Projects board | GitHub owns issues, assignees and board columns |
| Issue (tracked issue) | One open assigned issue the tracker follows: its title, linked branches, pull request and board column, and the branch and worktree Switchyard works on | GitHub; Switchyard keeps a snapshot |
| Keep a session in every worktree (project setting) | Every non-main worktree gets one session when it first appears | Switchyard |
| Remove merged worktrees (project setting) | When a worktree's pull request has merged, archive its sessions and remove the worktree and its local branch | GitHub (PR state) and host git |

## What happens

1. **An issue is assigned to you** in the tracker's owner: it appears in the Board's Not started column, under the tracker's view. Issues in repositories that have no project in Switchyard are counted in the tracker's error instead.
2. **Work starts** when the issue has a branch: a linked branch (the issue's Development sidebar, `gh issue develop`) or the head branch of an open pull request that closes it. **Start** on the Board (or dragging the issue to Working) creates the linked branch (`<number>-<title>`) for you when the tracker's host has a checkout, or a local branch of that name otherwise, then makes its worktree and opens an idle session titled `#<number> <title>`. A branch that already exists gets its worktree on its own at the next sync, or the worktree you already have is linked. Worktrees are made on the project's default host when it has a checkout there, else on the tracker's host.
3. **The pull request opens**: the branch moves to In review on the Board. **It merges**: the branch moves to Merged, and with "Remove merged worktrees" on, about ten minutes later its sessions are archived and the worktree and local branch removed.
4. **The issue closes or is unassigned**: it disappears from the tracker. The branch, its worktree and its sessions stay.

**Link by hand.** When you already started work in a worktree, open its session's menu and choose **Link to issue…**: it lists the project's issues that have no branch yet. The branch becomes the issue's branch, so its sessions stay in the tracker's view, and with write-back the card moves to the `--on-start` column at the next sync. A main checkout cannot be linked; pin the session to the view instead. **Unlink from #N** undoes a link GitHub does not know about. Once GitHub links a branch to the issue (its Development sidebar, or a pull request that closes it), GitHub's link is used.

Trackers create no tasks. Tasks are for automations ([spec.md](spec.md)).

## Setting up

Trackers use the host's `gh` login, like the rest of the [GitHub integration](github.md). For a Projects board, the login also needs the `project` scope: `gh auth refresh -h github.com -s project`. The tracker's host is only where `gh` runs; work happens on each project's default host.

1. Add the repositories as projects (Settings > Projects) on the hosts that will run the work, and turn on the two project settings if you want them.
2. Create a tracker in Settings > Trackers, or with the CLI:

   ```sh
   switchyard trackers create fieldgoal --host mac --owner fieldgoalco
   switchyard trackers create vo --host mac --owner VO-Health \
     --board 3 --on-start "In progress" --on-review "In review" --write-back
   ```

   `--repo owner/name` (repeatable) limits it to some repositories. `--status-field` names the board's status field (default `Status`). `--also owner/name` (repeatable) adds a repository of another owner, for work that lives outside the organization: its project joins the tracker's view and your assigned issues there are tracked too. An issue belongs to one tracker, so do not cover the same repository with two.
3. `switchyard trackers sync <name>` syncs now; otherwise every tracker syncs every two minutes. `switchyard trackers list` shows the last sync and error.

### In the web app

Settings > Trackers shows each tracker as a card: its owner and repositories, the signed-in GitHub user, the host, the board and how it moves cards, the last sync and any error, its issue count, and links that open its view on Sessions or the Board. Under Projects it lists the projects it covers, each with the two worktree switches. **Sync now** syncs at once; **Edit** and **Delete** change or remove it (its issues are removed, its view stays as an ordinary view). The view selector on Sessions and the Board names each view's source, such as `fieldgoal · GitHub`. Edit has "Repositories of other owners", the same as `--also`.

A tracker keeps a view of its own name pointed at the projects in its owner and its other repositories (an existing view of that name is adopted). Its project list is the tracker's; hosts and pins stay editable. The view holds the sessions on branches linked to the tracker's issues, in any state, plus any session in its repositories that is live right now; a stopped session with no issue is not in it. With that view selected, the Board can show the Projects board's own columns instead of stages. A herdr or tmux session bound to the view mirrors the same sessions: a stopped session with no issue leaves it. Bind a herdr session to it with `switchyard herdr pair --session <name> --view <name>`.

## Board write-back

With `--write-back`, Switchyard moves a card to the `--on-start` column once its worktree exists, and to the `--on-review` column once a pull request is open, at most once per column, so a card you move back stays where you put it. On the Board, with the tracker's columns shown, you can also drag a card to another column. Every move is checked on the host first, and skipped when:

- the card is no longer assigned to the tracker's user;
- someone else is assigned too and `--no-move-shared` is set (shared cards move by default);
- the card is no longer in the column Switchyard last saw (refresh and try again).

Only the status field is ever written. Draft items (not issues) are ignored.

## Limits

- Polling only (every two minutes); no webhooks. github.com only.
- At most 200 issues per tracker. Beyond that, nothing is removed until the list fits again.
- Board columns are not stages: stages (Not started, Working, In review, Merged) come from the branch and its pull request.
- Landed means: the pull request is merged, the worktree's HEAD is the merged head, the tree is clean, and no session is running, for ten minutes. A squash-merged branch with local commits added afterwards is kept.
- With `gh` missing or signed out, a tracker reports the error and nothing else changes.
