# Trackers and worktree rules

A tracker connects Switchyard to the GitHub issues assigned to you, so that work arrives on the board, gets a worktree and a session, and is cleaned up when it merges. It is one of three layers:

```
Trackers ──sync──> Project / Workspace / Task / Session <──filter── Views <──bind── Clients
(GitHub issues,            (Switchyard core)                                  (web, phone,
 GitHub Projects)                                                              herdr, tmux)
```

Trackers and clients never talk to each other; both meet at the core objects. A view is a lens over sessions with one source: your own filters and pins, a tracker, or a terminal ([terminal-sessions.md](terminal-sessions.md#views-and-tui-clients)).

| Concept | What it is | Who owns the truth |
|---|---|---|
| Tracker | The host user's open assigned issues in one GitHub owner (optionally some repositories), optionally with a Projects board | GitHub owns issues, assignees and board columns; Switchyard keeps a snapshot on each task |
| Keep a session in every worktree (project setting) | Every non-main worktree gets one session when it first appears | Switchyard |
| Remove merged worktrees (project setting) | When a worktree's pull request has merged, archive its sessions and remove the worktree and its local branch | GitHub (PR state) and host git |

## What happens

1. **An issue is assigned to you** in the tracker's owner: a Backlog task appears, titled like the issue, with a Tracker section (issue, branch, pull request, board column). Issues in repositories that have no project in Switchyard are counted in the tracker's error instead.
2. **Work starts** when a branch is associated with the issue: a linked branch (the issue's Development sidebar, `gh issue develop`) or the head branch of an open pull request that closes it. **Start work** on the task creates the linked branch (`<number>-<title>`) for you. Switchyard fetches the branch and creates its worktree once, or links the worktree you already have for that branch; with "Keep a session in every worktree" on, an idle session starts in it. The worktree shows up in the tracker's view in every client.
3. **The pull request merges**: with "Remove merged worktrees" on, about ten minutes later the sessions are archived and the worktree and local branch are removed.
4. **The issue closes or is unassigned**: its task disappears if it is still in Backlog with no session or run. Tasks with work are left alone.

The tracker owns its task only for these fields: the title while in Backlog, and the Tracker section. Moving the task to Ready dispatches it like any issue task (a new `sy/` worktree and the issue prompt), not into the tracker's worktree.

## Setting up

Trackers use the host's `gh` login, like the rest of the [GitHub integration](github.md). For a Projects board, the login also needs the `project` scope: `gh auth refresh -h github.com -s project`.

1. Add the repositories as projects (Settings > Projects) on the host that will run the work, and turn on the two project settings if you want them.
2. Create a tracker in Settings > Trackers, or with the CLI:

   ```sh
   switchyard trackers create fieldgoal --host mac --owner fieldgoalco
   switchyard trackers create vo --host mac --owner VO-Health \
     --board 3 --on-start "In progress" --on-review "In review" --write-back
   ```

   `--repo owner/name` (repeatable) limits it to some repositories. `--status-field` names the board's status field (default `Status`).
3. `switchyard trackers sync <name>` syncs now; otherwise every tracker syncs every two minutes. `switchyard trackers list` shows the last sync and error.

### In the web app

Settings > Trackers shows each tracker as a card: its owner and repositories, the signed-in GitHub user, the host, the board and how it moves cards, the last sync and any error, its task count, and links that open its view on Sessions or the Board. Under Projects it lists the projects it covers, each with the two worktree switches. **Sync now** syncs at once; **Edit** and **Delete** change or remove it (its tasks stay and stop updating, its view stays as an ordinary view). The view selector on Sessions and the Board names each view's source, such as `fieldgoal · GitHub`.

A tracker keeps a view of its own name pointed at the projects in its owner (an existing view of that name is adopted). Its project list is the tracker's; hosts and pins stay editable. Bind a herdr session to it with `switchyard herdr pair --session <name> --view <name>`.

## Board write-back

With `--write-back`, Switchyard moves a card to the `--on-start` column once its worktree exists, and to the `--on-review` column once a pull request is open, at most once per column, so a card you move back stays where you put it. The column can also be set from the task. Every move is checked on the host first, and skipped when:

- the card is no longer assigned to the tracker's user;
- someone else is assigned too and `--no-move-shared` is set (shared cards move by default);
- the card is no longer in the column Switchyard last saw (refresh and try again).

Only the status field is ever written. Draft items (not issues) are ignored.

## Limits

- Polling only (every two minutes); no webhooks. github.com only.
- At most 200 issues per tracker. Beyond that, nothing is removed until the list fits again.
- Board columns are not Switchyard task states: Ready authorizes agent dispatch, and task states follow runs.
- Landed means: the pull request is merged, the worktree's HEAD is the merged head, the tree is clean, and no session is running, for ten minutes. A squash-merged branch with local commits added afterwards is kept.
- With `gh` missing or signed out, a tracker reports the error and nothing else changes.
