import { GitHubApp } from "./github-app.js";

/** Serve only the inherited IPC channel; no network listener or credential-bearing logs. */
export async function runCatalogWorker(dataDir: string): Promise<void> {
  if (!process.send || !process.connected)
    throw new Error("Catalog worker requires a private IPC channel");
  const app = new GitHubApp(dataDir);
  const methods = {
    beginRegistration: app.beginRegistration.bind(app),
    completeRegistration: app.completeRegistration.bind(app),
    installationStatus: app.installationStatus.bind(app),
    listRepositories: app.listRepositories.bind(app),
    resolveRemote: app.resolveRemote.bind(app),
    issueCloneGrant: app.issueCloneGrant.bind(app),
    releaseGrant: app.releaseGrant.bind(app),
    disconnect: app.disconnect.bind(app),
  } as Record<string, (...args: any[]) => Promise<unknown>>;
  process.on("message", (message: any) => {
    if (
      !message ||
      !Number.isSafeInteger(message.id) ||
      typeof message.method !== "string" ||
      !Object.hasOwn(methods, message.method) ||
      !Array.isArray(message.args)
    )
      return;
    void methods[message.method](...message.args).then(
      (value) => {
        if (process.connected) process.send?.({ id: message.id, value });
      },
      (error: unknown) => {
        if (process.connected)
          process.send?.({
            id: message.id,
            error:
              error instanceof Error && error.constructor === Error
                ? error.message
                : "Provider operation failed",
            code:
              error instanceof Error &&
              error.message === "Reconnect provider: GitHub App credentials are missing or invalid"
                ? "provider_reconnect_required"
                : undefined,
          });
      },
    );
  });
  await new Promise<void>((resolve) => process.once("disconnect", resolve));
}
