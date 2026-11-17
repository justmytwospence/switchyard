import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { type EnrollMeta, metaPath, readEnrollMeta, socketDirs } from "@switchyard/pi-runtime";
import type { Logger } from "./logger.js";
import type { SessionSupervisor } from "./supervisor.js";

const SOCKET = /^ext-[0-9a-f]{8}\.sock$/;
/** A socket without readable meta this long is a leftover. */
const STALE_MS = 60_000;

/**
 * Finds Pi processes the user started that enrolled through an `ext-*.sock` in this agent's
 * runtime directory, and has the supervisor adopt each one once.
 */
export class ExternalSessionWatcher {
  private timer: NodeJS.Timeout | null = null;
  private scanning = false;
  private readonly reported = new Set<string>();

  constructor(
    private readonly opts: {
      supervisor: Pick<SessionSupervisor, "usesSocket" | "adoptExternal">;
      runtimeDir: string;
      log: Logger;
      intervalMs?: number;
    },
  ) {}

  start(): void {
    void this.scan();
    this.timer = setInterval(() => void this.scan(), this.opts.intervalMs ?? 5000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async scan(now = Date.now()): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    try {
      for (const dir of socketDirs(this.opts.runtimeDir)) {
        let names: string[];
        try {
          names = readdirSync(dir);
        } catch {
          continue;
        }
        for (const name of names) {
          if (!SOCKET.test(name)) continue;
          const path = join(dir, name);
          if (this.opts.supervisor.usesSocket(path)) continue;
          await this.offer(path, now);
        }
      }
    } finally {
      this.scanning = false;
    }
  }

  private remove(path: string): void {
    rmSync(path, { force: true });
    rmSync(metaPath(path), { force: true });
    this.reported.delete(path);
  }

  private async offer(path: string, now: number): Promise<void> {
    const meta: EnrollMeta | null = readEnrollMeta(path);
    if (!meta) {
      try {
        if (now - statSync(path).mtimeMs > STALE_MS) this.remove(path);
      } catch {
        // gone already
      }
      return;
    }
    try {
      process.kill(meta.pid, 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ESRCH") {
        this.remove(path);
        return;
      }
    }
    try {
      const result = await this.opts.supervisor.adoptExternal(path, meta);
      if (result === "adopted") {
        this.reported.delete(path);
        this.opts.log.info({ socketPath: path, pid: meta.pid }, "adopted a Pi from your terminal");
      }
    } catch (err) {
      if (!this.reported.has(path)) {
        this.reported.add(path);
        this.opts.log.warn({ socketPath: path, err: (err as Error).message }, "could not adopt Pi");
      }
    }
  }
}
