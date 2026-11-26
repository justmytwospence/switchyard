# The model

Switchyard tracks what you are working on as **branches**: a repository on a branch, each with one agent session you talk to. Everything else either feeds branches, selects them or shows them.

```
Sources ──annotate──> Branch ──has──> Sessions <──select── Scopes <──shown by── Clients
(GitHub issues,       (project + branch,  (one primary,     (named parts      (web app, phone,
 Projects boards)      its worktrees)      extras nested)    of your work)     herdr, tmux)
```

## Three questions

Every component answers one of three questions:

| Question | Components |
|---|---|
| What work is it? | Project, branch, session, and the issues a scope's source attaches. A **scope** is a named part of this work |
| Where does it run? | Host, workspace (the checkout), and how its Pi runs: held by Switchyard in a **terminal session**, in a pane you started it in yourself, or over RPC |
| Where do you look at it? | **Clients**: the web app, the phone, the CLI, and herdr and tmux sessions, which mirror nothing, everything or one scope |

A scope never depends on the client a session was started in or is shown in, so a session is in the same scopes everywhere. The Sessions page shows the second question instead of hiding it: each row says where its session runs (the herdr or tmux client of a Pi started by hand, or its host when there are several), and the **Where** layout groups by host, then client or Switchyard. From there **Where** can narrow the list to a client (the Pi running in that herdr or tmux session now) or a host; it combines with the selected scope and shows as its own chip beside the scope's. One herdr session can mirror everything, a herdr session per scope can each mirror a part, or both: the scopes are the same either way.

## The components

| Component | What it is | Who owns the truth |
|---|---|---|
| Host | A machine that runs agents and holds checkouts | The host: filesystem, git and processes |
| Project | A repository | Its git remote identity |
| **Branch** | A project on a branch: the row on Sessions and the card on the Board. Derived, never stored | Workspaces, sessions and tracked issues |
| Workspace | A branch's checkout on one host: the main checkout or a git worktree, with its git state | The host |
| Session | A Pi agent in a workspace. One per branch is **primary**; other sessions on the branch are **extras**; subagents hang off the session that started them | Pi owns the conversation; Switchyard owns which session is primary |
| Scope | A named part of your work: a set of projects you choose and pins, or the issues of a GitHub source (those assigned to you in one owner, or every open issue on a Projects board) ([scopes.md](scopes.md)). A scope can still limit hosts (older ones); new ones leave where sessions run to the Where filter | Switchyard; GitHub for a source's issues |
| Issue (tracked issue) | One issue a scope's source follows: its branch, pull request and board column | GitHub; Switchyard keeps a snapshot |
| Device | A sign-in credential: a browser, the installed app, a machine's CLI | Switchyard |
| Client | Anything signed in that shows your work. A herdr or tmux session is one Switchyard keeps a record of: it holds Pi you start there by hand (own panes) and, if you choose, mirrors nothing, everything or one scope as a tab per active branch. It is reported by the device its plugin signs in with, and on a host when there is one ([clients.md](clients.md)) | Switchyard records what it mirrors; its plugin reports what it shows |
| Task, Run | Automation: scheduled or dispatched work that makes its own worktree and session | Switchyard |

## How they work together

- **Opening work is one action: open a branch.** Switchyard finds or creates the worktree, finds or starts its primary session, and shows it. It is the same action for a new branch, an existing branch with no session, and a branch with a running agent (`POST /api/branches/open`; New session in the web app; Start session on an issue, or an issue chosen in New session).
- **A second session on a branch is allowed but out of the way.** You ask for it explicitly ("Start another session in this branch", or "New session in this branch" in the session menu). It nests under the primary behind a "+N" count and never becomes its own row. Choose another primary from the session menu.
- **The same branch on two hosts is one branch.** Each host keeps its own workspace with its own git state; the branch shows the host where its primary session runs. The Where layout splits it per host.
- **A source decorates branches.** An issue with a branch shows its issue, pull request and board column on that branch. An issue with no branch waits in the Board's Not started column; starting it makes the branch, its worktree on the project's default host, and an idle session.
- **A GitHub scope is its issues' work.** It holds the sessions on branches linked to its issues, whatever their state, plus any session in its repositories that is live right now. A stopped session with no issue is not in it; it is under All sessions.
- **Needs input is a question you can still answer.** When a session's Pi stops, its open questions expire and its "Needs input" clears, whatever raised them. Other attention (failed, ready to review) keeps its own label and does not keep a stopped session under Active. Clear a flag by hand from the session menu (Clear Needs input) or the Attention page (Clear).
- **A pin is membership only.** Pinning a session adds it to a scope; it does not keep the session from being archived, and archiving it removes its pins. Starting a session with a scope selected in the web app does not pin it; starting one from a herdr or tmux client that mirrors a scope pins it only when the scope would not show it otherwise, and says so. A pin does not open a mirror tab either: a pinned session's branch gets one while it is active, like any other.
- **A scope decides which branches you see; a client decides where.** Every client that mirrors a scope shows the same branches, and the web app and phone select a scope of their own. What a herdr or tmux client mirrors is recorded in Switchyard (`switchyard clients bind`, or Settings > Clients), never taken from its name.
- **A mirror shows branches, not every session.** It opens a tab for each branch's primary while the branch is active (live, waiting for input, unread, or active in the last 48 hours), so mirroring everything stays usable with hundreds of stopped sessions. Extras open on demand from a new tab. Closing a primary's tab archives it everywhere; closing an extra's only hides it.
- **Where a session runs is a fact on the session, not a scope.** A Pi you start in your own pane shows its client on its row and under Details (Runs in), with the same label ("herdr default on Mac", through the host's Switchyard name), and belongs to the same scopes as any other session in its project. After it stops, Details says where it last ran by hand. Which scope a client mirrors (Mirrored in, in the scope's Edit dialog) is a separate fact. A client you only work in by hand needs no binding: it mirrors nothing, and focusing such a Pi still counts as reading it.
- **Watching counts as reading.** The session in the focused pane of a herdr or tmux client you are attached to is viewed, like one open in the browser: it is not marked unread, and its notifications stay inline.
- **Cleanup follows the branch.** When the pull request merges and the worktree is clean and idle, its sessions are archived and the worktree removed (with "Remove merged worktrees" on).
- **A branch keeps its latest session.** Ended sessions that are not the primary are archived after three days, with their subagents ([operations.md](operations.md#ended-sessions)).
- **One owner starts and cleans up work.** Switchyard can do it (Start session, "Keep a session in every worktree", "Remove merged worktrees", board write-back), or your terminal tools can (a Pi plugin that starts issues in worktrees, a multiplexer that removes merged ones) while Switchyard only watches: sessions you start yourself are adopted, branches and issues are matched, nothing is created or removed. Pick one per project and turn the other off ([scopes.md](scopes.md#watching-only)).

## Where work shows

| Work | Where it shows |
|---|---|
| Not started: a tracked issue with no branch, or a worktree with no session | Board only (Not started, or Working with Start session) |
| Active: its session is live (starting, idle, running, waiting for input) | Sessions and Board |
| Needs input: its live session has a question you can still answer (a dialog, a plan to approve, an adapter's question) | Sessions under Active and Needs input, Attention, and Board |
| Stopped: its session is stopped, failed or interrupted | Sessions under All, and Board. In a GitHub scope, only when its branch is linked to one of the scope's issues or the session is pinned |

Create is always **Start session**; **Open** goes to a session that exists; **Resume** restarts a stopped one.

## Stages

A branch's stage comes from facts, never from a status Switchyard stores:

| Stage | When |
|---|---|
| Not started | A tracked issue with no branch yet |
| Working | The branch exists, with no open or merged pull request |
| In review | Its pull request is open |
| Merged | Its pull request has merged |

The Board shows branches by stage, or, for a GitHub scope with a Projects board, by that board's columns.

## Tasks

Tasks and runs are for automation: an automation or the task board (`/tasks`) dispatches a task, which gets its own worktree and session, checks and a review step. They are not the list of what you are working on; that list is your branches.
