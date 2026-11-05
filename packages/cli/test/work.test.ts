import { describe, expect, it } from "vitest";
import {
  automationsRun,
  parsePriority,
  parseStates,
  sessionsList,
  taskCreateBody,
  tasksCreate,
  tasksList,
  tasksMove,
} from "../src/commands/work.js";
import { buildProgram } from "../src/main.js";
import { PROJECT, stubFetch, testCtx } from "./helpers.js";

const conn = { coordinator: "http://coord", credential: "cred" };

describe("tasks", () => {
  it("builds the create body", () => {
    expect(
      taskCreateBody("prj_1", {
        project: "Alpha",
        title: "Fix",
        objective: "Make it work",
        criteria: [" tests pass ", "", "docs"],
        priority: "High",
        ready: true,
      }),
    ).toEqual({
      projectId: "prj_1",
      title: "Fix",
      objective: "Make it work",
      acceptanceCriteria: ["tests pass", "docs"],
      state: "ready",
      priority: 1,
    });
    expect(taskCreateBody("prj_1", { project: "p", title: "t" })).toEqual({
      projectId: "prj_1",
      title: "t",
      objective: "",
      acceptanceCriteria: [],
      state: "backlog",
    });
  });

  it("parses priorities and states", () => {
    expect(parsePriority("0")).toBe(0);
    expect(parsePriority("low")).toBe(3);
    expect(() => parsePriority("9")).toThrow(/Priority/);
    expect(parseStates("ready,review")).toEqual(["ready", "review"]);
    expect(() => parseStates("doing")).toThrow(/Unknown state/);
  });

  it("creates a task, resolving the project by name, with the bearer credential", async () => {
    const { fetch, calls } = stubFetch({
      "GET /api/projects": () => [PROJECT],
      "POST /api/tasks": (c) => ({
        status: 201,
        body: { id: "tsk_1", ...(c.body as object), state: "ready" },
      }),
    });
    const ctx = testCtx(fetch);
    await tasksCreate(ctx, { ...conn, project: "alpha", title: "Fix", ready: true });
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.auth).toBe("Bearer cred");
    expect(post.body).toEqual({
      projectId: "prj_1",
      title: "Fix",
      objective: "",
      acceptanceCriteria: [],
      state: "ready",
    });
    expect(ctx.lines[0]).toBe("Created tsk_1: Fix (ready)");
  });

  it("parses `tasks create` arguments through commander", async () => {
    const { fetch, calls } = stubFetch({
      "GET /api/projects": () => [PROJECT],
      "POST /api/tasks": (c) => ({ status: 201, body: { id: "tsk_1", ...(c.body as object) } }),
    });
    const ctx = testCtx(fetch);
    await buildProgram(ctx).parseAsync(
      [
        "tasks",
        "create",
        "--coordinator",
        "http://coord",
        "--credential",
        "cred",
        "--project",
        "prj_1",
        "--title",
        "Ship it",
        "--objective",
        "Release v1",
        "--criteria",
        "builds",
        "tests pass",
        "--priority",
        "0",
      ],
      { from: "user" },
    );
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({
      projectId: "prj_1",
      title: "Ship it",
      objective: "Release v1",
      acceptanceCriteria: ["builds", "tests pass"],
      state: "backlog",
      priority: 0,
    });
  });

  it("lists tasks with a state filter and as JSON", async () => {
    const task = {
      id: "tsk_1",
      projectId: "prj_1",
      title: "Fix",
      state: "ready",
      priority: 2,
      blocked: null,
    };
    const { fetch, calls } = stubFetch({
      "GET /api/tasks": () => [task],
      "GET /api/projects": () => [PROJECT],
    });
    const ctx = testCtx(fetch);
    await tasksList(ctx, { ...conn, state: "ready,review" });
    expect(calls[0]?.path).toBe("/api/tasks?state=ready%2Creview");
    expect(ctx.lines).toEqual([
      "ID     STATE  PRIORITY  PROJECT  TITLE",
      "tsk_1  ready  Normal    Alpha    Fix",
    ]);
    const json = testCtx(fetch);
    await tasksList(json, { ...conn, json: true });
    expect(JSON.parse(json.lines.join("\n"))).toEqual([task]);
  });

  it("moves a task with confirm and the running choice", async () => {
    const { fetch, calls } = stubFetch({
      "POST /api/tasks/tsk_1/move": () => ({ id: "tsk_1", title: "Fix", state: "backlog" }),
    });
    const ctx = testCtx(fetch);
    await tasksMove(ctx, "tsk_1", "backlog", { ...conn, confirm: true, onRunning: "pause" });
    expect(calls[0]?.body).toEqual({ to: "backlog", confirm: true, onRunning: "pause" });
    expect(ctx.lines).toEqual(["Moved Fix to backlog"]);
    await expect(tasksMove(ctx, "tsk_1", "nope", conn)).rejects.toThrow(/Unknown state/);
  });
});

describe("sessions and automations", () => {
  it("lists sessions with project and host names", async () => {
    const { fetch } = stubFetch({
      "GET /api/sessions": () => [
        {
          id: "ses_1",
          title: "Fix login",
          runtime: "running",
          projectId: "prj_1",
          hostId: "hst_1",
          lastActivityAt: new Date().toISOString(),
        },
      ],
      "GET /api/projects": () => [PROJECT],
      "GET /api/hosts": () => [{ id: "hst_1", name: "mac" }],
    });
    const ctx = testCtx(fetch);
    await sessionsList(ctx, conn);
    expect(ctx.lines[1]).toMatch(/^ses_1\s+running\s+Alpha\s+mac\s+\d+s ago\s+Fix login$/);
  });

  it("fires an automation", async () => {
    const { fetch, calls } = stubFetch({
      "POST /api/automations/aut_1/run": () => ({
        status: 201,
        body: {
          occurrence: { id: "occ_1", state: "fired", reason: null },
          task: { id: "tsk_9", title: "Nightly", state: "ready" },
        },
      }),
    });
    const ctx = testCtx(fetch);
    await automationsRun(ctx, "aut_1", conn);
    expect(calls[0]?.method).toBe("POST");
    expect(ctx.lines).toEqual(['Occurrence occ_1: fired; task tsk_9 "Nightly" is ready']);
  });
});
