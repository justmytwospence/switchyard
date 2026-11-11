# Switchyard: agent instructions

Build, test and release details are in [docs/development.md](docs/development.md).

## Branches and worktrees

- `dev` is the working branch (and GitHub's default), checked out in the main checkout `~/Projects/switchyard`. `main` is production: it moves only by `scripts/promote.sh`, never by a direct commit or push.
- Quick changes: commit on `dev`, push, run `scripts/deploy-dev.sh`, and have Spencer review on dev.switchyard.
- Larger or parallel work: a branch in `.worktrees/<branch>` from `dev` (`git worktree add .worktrees/<branch> -b <branch> dev`, from the main checkout). Push it and review it on its preview (`scripts/preview.sh up`). When it is ready, merge it into `dev`, push `dev` and deploy-dev, then `scripts/preview.sh down` (or `prune`) and remove the worktree and branch.
- Production: only on explicit instruction. Once Spencer approves what is on dev.switchyard, `scripts/promote.sh` fast-forwards `main` to it, then tag `vX.Y.Z` on `main` per docs/development.md. `release.yml` refuses tags that are not on `main`.

## Anything for Spencer to review goes to a deployment

Spencer reviews and tries changes on a deployment, never on a local `up --dev` or Vite server:

- **dev**: https://dev.switchyard.spencerboucher.com (coordinator on `:dev`, with the NUC and this Mac as hosts). Commit on `dev`, push, and run `scripts/deploy-dev.sh` from the main checkout. It waits for CI and the `:dev` image, redeploys the dev coordinator on the NUC and checks its revision, then rebuilds this checkout and restarts the Mac's dev host agent.
- **a branch**: https://<slug>.switchyard-dev.spencerboucher.com (`scripts/preview-slug.sh <branch>` gives the slug). Push the branch and run `scripts/preview.sh up` from its worktree. It waits for CI and the `:br-<slug>` image, starts a throwaway coordinator on the NUC with its own data and pairing-only sign-in, installs a host agent on this Mac running the worktree's build, and prints a single-use sign-in link (`scripts/preview.sh pair` prints a new one).

Then:

- Tell him what to check there, with the URL and the revision the script printed (and, for a preview, the sign-in link). Do not ask him to run local servers or deploy commands himself.
- If the deploy fails (CI red, revision mismatch, ssh unreachable), fix it or report it. Do not fall back to asking him to test locally.
- A plan's manual verification step is written as "on <url>, check ...", and comes after the deploy step.
