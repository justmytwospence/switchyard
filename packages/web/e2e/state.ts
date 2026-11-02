import { readFileSync } from "node:fs";

/** Port of the e2e coordinator (serves the built web app). */
export const E2E_PORT = Number(process.env.SY_E2E_PORT ?? 7488);
export const E2E_URL = `http://127.0.0.1:${E2E_PORT}`;

/** Seed data written by global-setup.ts and read by every spec. */
export interface E2EState {
  baseURL: string;
  adminToken: string;
  root: string;
  repoPath: string;
  hostId: string;
  hostName: string;
  projectId: string;
  projectName: string;
  workspaceId: string;
  sessions: {
    /** Long transcript with a tool card; idle. */
    long: string;
    /** Pending fixture_select question ("Pick a fruit"). */
    question: string;
  };
  tasks: {
    backlog: string;
    ready: string;
    running: string;
    review: string;
    done: string;
  };
  /** Session of the running task. */
  runningSessionId: string;
  /** Session of the review task. */
  reviewSessionId: string;
  automationId: string;
  /** Paths changed in the main checkout (the Changes inspector lists them). */
  changedFiles: string[];
}

export function readState(): E2EState {
  const file = process.env.SY_E2E_STATE;
  if (!file) throw new Error("SY_E2E_STATE is not set; run through playwright.config.ts");
  return JSON.parse(readFileSync(file, "utf8")) as E2EState;
}
