# GitHub integration

This describes the phase 3 implementation under development, not a reviewed or shipped release.

## Host setup

Install `gh` on each workspace host and authenticate as the host user, for example `gh auth login --hostname github.com`; check with `gh auth status --hostname github.com`. Switchyard uses that host's existing login and stores no GitHub token on the coordinator. Only github.com is supported, not GitHub Enterprise hosts. Missing `gh`, missing or expired authentication, inaccessible repositories and offline hosts are surfaced as availability or discovery reasons, not proof that no PR exists.

## Pull requests

The workspace Inspector discovers a branch's PR and displays its head, checks, unresolved review threads, merge state and freshness. Details retains discovery status and refresh even when there is no PR tab. Refresh is also triggered on idle; the visible, selected PR panel polls periodically. Partial, stale, unavailable and ambiguous results are shown as such.

The user can explicitly send failing CI or unresolved review comments to the agent. CI prompts classify failures as real, flaky or infrastructure and include available verified job log tails (up to 150 lines); review prompts ask for code changes without resolving GitHub threads or committing unless requested. Both treat external text as untrusted and report omissions. Refresh alone sends nothing.

Squash merge is a separate explicit confirmation against the displayed head SHA. Switchyard rechecks PR identity, head, mergeability, checks, review and snapshot completeness, and uses GitHub's SHA-guarded direct merge endpoint. Stale, incomplete, offline or ambiguous data blocks the action; a changed head requires refresh and a new confirmation. Auto-merge, merge queues, admin bypass and branch deletion are not performed. If the outcome is unknown, refresh and reconcile rather than blindly retrying. Accepting a Switchyard task does not merge it.

## Tasks from issues

Create a task with a canonical `https://github.com/OWNER/REPO/issues/NUMBER` URL (no query, fragment or trailing slash). The issue is not fetched at creation and `gh` authentication is not needed merely to save the URL. An empty title defaults to `OWNER/REPO #NUMBER`. The first logical launch and its transport retries use this frozen prompt, with no trailing newline:

```text
https://github.com/Owner/Repo/issues/17

Read it with `gh issue view https://github.com/Owner/Repo/issues/17`.
```

Issue imports start with continuation disabled and human review required. Editing the task's objective or acceptance text later does not alter that first prompt; later attempts use current task details and review feedback. The agent needs appropriate host-side `gh` access to read the issue.
