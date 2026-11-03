# Switchyard: agent instructions

Build, test and release details are in [docs/development.md](docs/development.md).

## Anything for Spencer to review goes to switchyard-dev

Spencer reviews and tries changes on the development deployment, https://switchyard-dev.spencerboucher.com (coordinator on `:edge`, with the NUC and this Mac as hosts), never on a local `up --dev` or Vite server.

- Before handing over anything for him to check (a manual verification step, a UI change, "try it"), commit it, push `main`, and run `scripts/deploy-dev.sh`. The script waits for CI and the `:edge` image, redeploys switchyard-dev on the NUC and checks its revision, then rebuilds this checkout and restarts the Mac's dev host agent.
- Then tell him what to check there, with the URL and the revision the script printed. Do not ask him to run local servers or deploy commands himself.
- If the deploy fails (CI red, revision mismatch, ssh unreachable), fix it or report it. Do not fall back to asking him to test locally.
- A plan's manual verification step is written as "on switchyard-dev, check ...", and comes after the deploy step.
