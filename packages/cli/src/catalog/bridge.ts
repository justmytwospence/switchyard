import { type ChildProcess, fork } from "node:child_process";
import type { RepositoryProvider } from "@switchyard/coordinator";
import type { CatalogRepository } from "@switchyard/protocol";
import type { AccountType } from "./github-app.js";

export class CatalogProviderReconnectError extends Error {
  readonly code = "provider_reconnect_required";
}

/** The worker is lazy: provider failures never prevent coordinator startup. */
export class CatalogBridge implements RepositoryProvider {
  readonly authority = "github.com";
  private child: ChildProcess | undefined;
  private pending = new Map<
    number,
    { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  private sequence = 0;
  private stopped = false;
  private failures = 0;
  private retryAt = 0;
  constructor(
    private dataDir: string,
    private entry = process.argv[1],
  ) {}
  private start(): ChildProcess {
    if (this.stopped) throw new Error("Catalog worker stopped");
    if (this.child?.connected) return this.child;
    if (Date.now() < this.retryAt) throw new Error("Catalog worker temporarily unavailable");
    const child = fork(this.entry, ["catalog-worker", "--data-dir", this.dataDir], {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      execArgv: [],
    });
    this.child = child;
    child.on("message", (message: any) => {
      const item = this.pending.get(message?.id);
      if (!item) return;
      this.pending.delete(message.id);
      clearTimeout(item.timer);
      this.failures = 0;
      if (message.code === "provider_reconnect_required")
        item.reject(
          new CatalogProviderReconnectError(
            "Reconnect provider: GitHub App credentials are missing or invalid",
          ),
        );
      else if (typeof message.error === "string") item.reject(new Error(message.error));
      else item.resolve(message.value);
    });
    const failed = () => {
      if (this.child !== child) return;
      this.child = undefined;
      this.failures++;
      this.retryAt = Date.now() + Math.min(30000, 250 * 2 ** Math.min(this.failures - 1, 7));
      for (const item of this.pending.values()) {
        clearTimeout(item.timer);
        item.reject(new Error("Catalog worker unavailable"));
      }
      this.pending.clear();
    };
    child.on("error", failed);
    child.on("exit", failed);
    return child;
  }
  private call(method: string, ...args: unknown[]): Promise<any> {
    let child: ChildProcess;
    try {
      child = this.start();
    } catch (error) {
      return Promise.reject(error);
    }
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Catalog worker timed out"));
        child.kill();
      }, 60000);
      this.pending.set(id, { resolve, reject, timer });
      child.send!({ id, method, args }, (error) => {
        if (error) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(new Error("Catalog worker unavailable"));
        }
      });
    });
  }
  beginRegistration(input: {
    connectionId: string;
    account: string;
    accountType: AccountType;
    returnUrl: string;
    state: string;
  }): Promise<{ url: string; fields: Record<string, string> }> {
    return this.call("beginRegistration", input);
  }
  completeRegistration(input: {
    connectionId: string;
    account: string;
    accountType: AccountType;
    code: string;
  }): Promise<{ installUrl: string }> {
    return this.call("completeRegistration", input);
  }
  listRepositories(
    id: string,
  ): Promise<
    | { state: "ready"; repositories: CatalogRepository[]; manageUrl: string }
    | { state: "pending" | "suspended" | "removed"; manageUrl?: string }
  > {
    return this.call("listRepositories", id);
  }
  resolveRemote(id: string, identity: string): Promise<string | null> {
    return this.call("resolveRemote", id, identity);
  }
  issueCloneGrant(
    id: string,
    repository: CatalogRepository,
  ): Promise<{ token: string; expiresAt: string }> {
    return this.call("issueCloneGrant", id, repository);
  }
  releaseGrant(token: string): Promise<void> {
    return this.call("releaseGrant", token);
  }
  disconnect(id: string): Promise<void> {
    return this.call("disconnect", id);
  }
  stop(): void {
    this.stopped = true;
    this.child?.kill();
  }
}
