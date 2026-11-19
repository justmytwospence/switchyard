# The model

Switchyard tracks what you are working on as **branches**: a repository on a branch, each with one agent session you talk to. Everything else either feeds branches, filters them or shows them.

```
Trackers ──annotate──> Branch ──has──> Sessions <──query── Views <──shown on── Surfaces
(GitHub issues,        (project + branch,  (one primary,      (saved           (herdr, tmux;
 Projects boards)       its worktrees)      extras nested)     filters)         browsers and phones
                                                                                are devices)
```

## The components

| Component | What it is | Who owns the truth |
|---|---|---|
| Host | A machine that runs agents and holds checkouts | The host: filesystem, git and processes |
| Project | A repository | Its git remote identity |
| **Branch** | A project on a branch: the row on Sessions and the card on the Board. Derived, never stored | Workspaces, sessions and tracked issues |
| Workspace | A branch's checkout on one host: the main checkout or a git worktree, with its git state | The host |
| Session | A Pi agent in a workspace. One per branch is **primary**; other sessions on the branch are **extras**; subagents hang off the session that started them | Pi owns the conversation; Switchyard owns which session is primary |
| Tracker | A GitHub owner's open issues that Switchyard follows (those assigned to you, or every open issue on a Projects board), optionally with a Projects board ([trackers.md](trackers.md)) | GitHub |
| Issue (tracked issue) | One issue a tracker follows: its branch, pull request and board column | GitHub; Switchyard keeps a snapshot |
| View | A saved filter: projects, hosts, pins, and an optional source (a tracker, or the terminal sessions are started in) | Switchyard |
| Device | A sign-in credential: a browser, the installed app, a terminal | Switchyard |
| Surface | A herdr or tmux session that shows one view, reported by the device it is signed in with, and on a host when there is one | Switchyard |
| Task, Run | Automation: scheduled or dispatched work that makes its own worktree and session | Switchyard |

## How they work together

- **Opening work is one action: open a branch.** Switchyard finds or creates the worktree, finds or starts its primary session, and shows it. It is the same action for a new branch, an existing branch with no session, and a branch with a running agent (`POST /api/branches/open`; New session in the web app; Start session on an issue, or an issue chosen in New session).
- **A second session on a branch is allowed but out of the way.** You ask for it explicitly ("Start another session in this branch", or "New session in this branch" in the session menu). It nests under the primary behind a "+N" count and never becomes its own row. Choose another primary from the session menu.
- **The same branch on two hosts is one branch.** Each host keeps its own workspace with its own git state; the branch shows the host where its primary session runs. The Hosts layout splits it per host.
- **Trackers decorate branches.** An issue with a branch shows its issue, pull request and board column on that branch. An issue with no branch waits in the Board's Not started column; starting it makes the branch, its worktree on the project's default host, and an idle session.
- **A tracker's view is its issues' work.** It holds the sessions on branches linked to the tracker's issues, whatever their state, plus any session in the tracker's repositories that is live right now. A stopped session with no issue is not in it; it is under All sessions.
- **A view decides which branches you see; a surface decides where.** Every surface bound to a view shows the same sessions, and the web app and phone select a view of their own. Closing a tab in one surface archives the session everywhere.
- **Where a session was started is a fact on the session.** A view whose source is a terminal (`--client herdr:<session>`) holds every Pi started there, including ones that started before the view existed.
- **Cleanup follows the branch.** When the pull request merges and the worktree is clean and idle, its sessions are archived and the worktree removed (with "Remove merged worktrees" on).

## Where work shows

| Work | Where it shows |
|---|---|
| Not started: a tracked issue with no branch, or a worktree with no session | Board only (Not started, or Working with Start session) |
| Active: its session is live (starting, idle, running, waiting for input) | Sessions and Board |
| Stopped: its session is stopped, failed or interrupted | Sessions under All, and Board. In a tracker's view, only when its branch is linked to one of the tracker's issues or the session is pinned |

Create is always **Start session**; **Open** goes to a session that exists; **Resume** restarts a stopped one.

## Stages

A branch's stage comes from facts, never from a status Switchyard stores:

| Stage | When |
|---|---|
| Not started | A tracked issue with no branch yet |
| Working | The branch exists, with no open or merged pull request |
| In review | Its pull request is open |
| Merged | Its pull request has merged |

The Board shows branches by stage, or, for a tracker's view with a GitHub Projects board, by that board's columns.

## Tasks

Tasks and runs are for automation: an automation or the task board (`/tasks`) dispatches a task, which gets its own worktree and session, checks and a review step. They are not the list of what you are working on; that list is your branches.
