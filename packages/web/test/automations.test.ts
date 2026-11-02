import type { Occurrence } from "@switchyard/protocol";
import { describe, expect, it } from "vitest";
import {
  curlExample,
  describeCron,
  describeCronOrRaw,
  describeTrigger,
  draftFromAutomation,
  draftToInput,
  emptyDraft,
  fieldForPath,
  isoToLocalInput,
  localInputToIso,
  mergeOccurrences,
  normalizeHistory,
  summarizeAutomation,
  validateCron,
  validateDraft,
  validateTimezone,
} from "../src/features/automations/describe";

describe("describeCron", () => {
  it.each([
    ["0 9 * * 1-5", "Every weekday at 09:00"],
    ["30 8 * * *", "Every day at 08:30"],
    ["0 9,17 * * *", "Every day at 09:00 and 17:00"],
    ["*/15 * * * *", "Every 15 minutes"],
    ["* * * * *", "Every minute"],
    ["0 * * * *", "Every hour"],
    ["5 * * * *", "Every hour at :05"],
    ["0 */2 * * *", "Every 2 hours"],
    ["30 */6 * * *", "Every 6 hours at :30"],
    ["0 9 * * 1", "Every Monday at 09:00"],
    ["0 9 * * MON,WED,FRI", "Every Monday, Wednesday and Friday at 09:00"],
    ["0 10 * * 0,6", "Every Saturday and Sunday at 10:00"],
    ["0 0 1 * *", "On the 1st of every month at 00:00"],
    ["0 0 1,15 * *", "On the 1st and 15th of every month at 00:00"],
    ["0 6 2 1,7 *", "On the 2nd of January and July at 06:00"],
    ["*/30 * * * 1-5", "Every 30 minutes on weekdays"],
    ["0 9-17 * * 1-5", "Every hour from 09:00 to 17:00 on weekdays"],
    ["*/10 9-17 * * *", "Every 10 minutes from 09:00 to 17:59"],
    ["0 9 * 12 *", "Every day in December at 09:00"],
    ["0 9 * * 7", "Every Sunday at 09:00"],
  ])("%s -> %s", (expr, expected) => {
    expect(describeCron(expr)).toBe(expected);
  });

  it("appends the timezone", () => {
    expect(describeCron("0 9 * * 1-5", "America/Denver")).toBe(
      "Every weekday at 09:00 (America/Denver)",
    );
  });

  it("returns null for expressions it cannot describe, with a raw fallback", () => {
    expect(describeCron("0 9 1 * 1")).toBeNull();
    expect(describeCron("0 9 L * *")).toBeNull();
    expect(describeCronOrRaw("0 9 1 * 1", "UTC")).toBe("Cron 0 9 1 * 1 (UTC)");
  });
});

describe("validateCron", () => {
  it("accepts valid expressions", () => {
    expect(validateCron("0 9 * * 1-5")).toBeNull();
    expect(validateCron("*/5 0-23/2 1,15 jan-jun sun")).toBeNull();
  });
  it("rejects wrong field counts and out-of-range values", () => {
    expect(validateCron("")).toMatch(/Enter/);
    expect(validateCron("0 9 * *")).toMatch(/5 fields/);
    expect(validateCron("0 9 * * * *")).toMatch(/got 6/);
    expect(validateCron("60 9 * * *")).toMatch(/^Minute: 60 is out of range/);
    expect(validateCron("0 24 * * *")).toMatch(/^Hour/);
    expect(validateCron("0 9 0 * *")).toMatch(/^Day of month/);
    expect(validateCron("0 9 * 13 *")).toMatch(/^Month/);
    expect(validateCron("0 9 * * 8")).toMatch(/^Day of week/);
    expect(validateCron("0 9 * * 5-1")).toMatch(/backwards/);
    expect(validateCron("x 9 * * *")).toMatch(/not a number/);
  });
});

describe("validateTimezone", () => {
  it("checks IANA names", () => {
    expect(validateTimezone("America/Denver")).toBeNull();
    expect(validateTimezone("Not/AZone")).toMatch(/Unknown timezone/);
    expect(validateTimezone("")).toMatch(/Enter/);
  });
});

describe("describeTrigger", () => {
  const fmt = (iso: string) => `<${iso}>`;
  it("summarizes each trigger kind", () => {
    expect(describeTrigger({ kind: "manual" })).toBe("Manual");
    expect(
      describeTrigger({ kind: "once", at: "2026-11-02T16:00:00.000Z" }, { formatDate: fmt }),
    ).toBe("Once at <2026-11-02T16:00:00.000Z>");
    expect(describeTrigger({ kind: "cron", expr: "0 9 * * 1-5", timezone: "UTC" })).toBe(
      "Every weekday at 09:00 (UTC)",
    );
    expect(describeTrigger({ kind: "cron", expr: "0 9 L * *", timezone: "UTC" })).toBe(
      "Cron 0 9 L * * (UTC)",
    );
    expect(describeTrigger({ kind: "webhook" })).toBe("Webhook");
    expect(
      describeTrigger(
        { kind: "dependency", taskId: "t1" },
        { taskTitle: (id) => (id === "t1" ? "Ship it" : undefined) },
      ),
    ).toBe('When "Ship it" is done');
    expect(describeTrigger({ kind: "dependency", taskId: "t9" })).toBe("When task t9 is done");
  });
});

describe("summarizeAutomation", () => {
  const base = {
    ...emptyDraft({ projectId: "p1", timezone: "America/Denver" }),
    name: "Daily triage",
    triggerKind: "cron" as const,
    cronExpr: "0 9 * * 1-5",
    title: "Triage issues",
  };

  it("describes a scheduled fresh automation", () => {
    expect(summarizeAutomation(draftToInput(base), { projectName: "Web", hostName: "nuc" })).toBe(
      'Every weekday at 09:00 (America/Denver), create a fresh task "Triage issues" in Web on nuc; skip if previous work is still open; skip missed runs; requires human review',
    );
  });

  it("covers continue, webhook filters, limits and checks", () => {
    const text = summarizeAutomation(
      draftToInput({
        ...base,
        triggerKind: "webhook",
        filters: [{ path: "action", equals: "opened" }],
        mode: "continue",
        groupingKey: "pr-{{payload.number}}",
        overlap: "append",
        continuationEnabled: true,
        continuationObjective: "Finish",
        maxContinuations: "3",
        maxElapsedMinutes: "30",
        checks: "pnpm test\npnpm lint",
        requireHumanReview: false,
      }),
      { projectName: "Web" },
    );
    expect(text).toBe(
      'When a webhook is received where action = "opened", continue the task grouped by "pr-{{payload.number}}" (or create "Triage issues") in Web on the project\'s default host; append to the open task if previous work is still open; continue automatically up to 3 times within 30 minutes; run 2 checks; no human review required',
    );
  });

  it("describes manual watch automations without a missed-run clause", () => {
    const text = summarizeAutomation(
      draftToInput({ ...base, triggerKind: "manual", mode: "watch", overlap: "queue_one" }),
    );
    expect(text).toMatch(/^When run manually, create a watch task "Triage issues"/);
    expect(text).toContain("queue one occurrence");
    expect(text).not.toContain("missed");
  });
});

describe("draft conversion and validation", () => {
  it("round-trips through AutomationInput", () => {
    const draft = {
      ...emptyDraft({ projectId: "p1", timezone: "UTC" }),
      name: "N",
      title: "T",
      criteria: "a\n\n b ",
      checks: "",
      continuationEnabled: true,
      continuationObjective: "Keep going",
      maxContinuations: "4",
      maxElapsedMinutes: "90",
      maxCostUsd: "1.5",
    };
    const { input, errors } = validateDraft(draft);
    expect(errors).toEqual({});
    expect(input?.template.acceptanceCriteria).toEqual(["a", "b"]);
    expect(input?.completion.checks).toBeNull();
    expect(input?.continuation).toEqual({
      enabled: true,
      objective: "Keep going",
      maxContinuations: 4,
      maxElapsedMinutes: 90,
      maxTokens: null,
      maxCostUsd: 1.5,
    });
    const back = draftFromAutomation(input!, { timezone: "UTC" });
    expect(back.criteria).toBe("a\nb");
    expect(back.maxCostUsd).toBe("1.5");
  });

  it("reports inline field errors", () => {
    const { input, errors } = validateDraft({
      ...emptyDraft({ timezone: "UTC" }),
      triggerKind: "cron",
      cronExpr: "0 9 * *",
      mode: "continue",
      continuationEnabled: true,
      maxContinuations: "99",
      filters: [{ path: "", equals: "x" }],
    });
    expect(input).toBeNull();
    expect(errors.name).toBeDefined();
    expect(errors.projectId).toBeDefined();
    expect(errors.title).toBeDefined();
    expect(errors.cronExpr).toMatch(/5 fields/);
    expect(errors.groupingKey).toMatch(/grouping key/);
    expect(errors.continuationObjective).toBeDefined();
    expect(errors.maxContinuations).toMatch(/1 to 50/);
    expect(errors["filters.0.path"]).toBeDefined();
  });

  it("maps zod paths to fields", () => {
    expect(fieldForPath(["continuation", "maxTokens"])).toBe("maxTokens");
    expect(fieldForPath(["filters", 2, "equals"])).toBe("filters.2.equals");
    expect(fieldForPath(["template", "acceptanceCriteria", 0])).toBe("criteria");
    expect(fieldForPath(["nope"])).toBe("form");
  });

  it("converts datetime-local values", () => {
    const iso = localInputToIso("2026-11-02T09:30");
    expect(isoToLocalInput(iso)).toBe("2026-11-02T09:30");
    expect(localInputToIso("")).toBe("");
  });
});

describe("history helpers", () => {
  const occ = (
    id: string,
    createdAt: string,
    state: Occurrence["state"] = "fired",
  ): Occurrence => ({
    id,
    automationId: "a1",
    key: id,
    scheduledFor: null,
    state,
    taskId: null,
    reason: null,
    outcome: null,
    createdAt,
  });

  it("merges, dedupes and sorts newest first", () => {
    const merged = mergeOccurrences(
      [occ("o1", "2026-01-01T00:00:00Z"), occ("o2", "2026-01-02T00:00:00Z")],
      [occ("o2", "2026-01-02T00:00:00Z", "failed"), occ("o3", "2026-01-03T00:00:00Z")],
    );
    expect(merged.map((o) => o.id)).toEqual(["o3", "o2", "o1"]);
    expect(merged[1]!.state).toBe("failed");
  });

  it("normalizes history responses", () => {
    expect(normalizeHistory([occ("a", "x")])).toHaveLength(1);
    expect(normalizeHistory({ items: [occ("a", "x")] })).toHaveLength(1);
    expect(normalizeHistory(null)).toEqual([]);
  });

  it("builds the curl example", () => {
    expect(curlExample("tok", "https://h/api/hooks/a1")).toBe(
      "curl -X POST -H 'Authorization: Bearer tok' -H 'Content-Type: application/json' -d '{}' https://h/api/hooks/a1",
    );
  });
});
