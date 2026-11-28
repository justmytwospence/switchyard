import type { Checkout, Host, OpenIssueRequest, Scope } from "@switchyard/protocol";
import { discoveryWriteBackHint, sourceNeedsRefresh } from "../scopes/describe";
import type { IssueInventoryItem, IssueLocator } from "./model";

export interface IssueActionOptions {
  instruction?: string;
  hostId?: string | null;
  profileId?: string | null;
  checkouts?: Record<string, Pick<Checkout, "projectId" | "hostId">>;
  hosts?: Record<string, Pick<Host, "name">>;
  scopes?: Record<string, Scope>;
}

interface ActionCopy {
  label: string;
  consequences: string[];
}

export type IssueAction = ActionCopy &
  (
    | { kind: "open"; sessionId: string }
    | {
        kind: "start";
        locator: IssueLocator;
        request: Pick<OpenIssueRequest, "hostId" | "prompt"> & { profileId?: string };
      }
    | { kind: "none" }
  );

/** Intent for a fresh synced item. This never starts, resumes, sends or pins anything itself. */
export function issueAction(
  item: IssueInventoryItem,
  options: IssueActionOptions = {},
): IssueAction {
  const instruction = options.instruction?.trim() ? options.instruction : null;
  if (item.sessionId) {
    return {
      kind: "open",
      label: "Open session",
      sessionId: item.sessionId,
      consequences: instruction
        ? ["Your instruction stays a draft; opening does not send it."]
        : [],
    };
  }
  if (item.merged) return { kind: "none", label: "Merged", consequences: [] };

  const { issue, locator, sourceId } = item;
  const { hostId, profileId } = options;
  const sourceScope = sourceId ? options.scopes?.[sourceId] : undefined;
  const source = sourceScope?.source;
  if ((source && sourceNeedsRefresh(source)) || (sourceId && options.scopes && !source)) {
    return { kind: "none", label: "Refresh the source before starting", consequences: [] };
  }
  const sourceHostId = source?.hostId;
  const branch = item.branchName;
  const consequences: string[] = [];
  if (!branch) {
    consequences.push("Create branch and worktree");
    const sourceCheckout =
      sourceHostId &&
      Object.values(options.checkouts ?? {}).some(
        (checkout) => checkout.projectId === issue.projectId && checkout.hostId === sourceHostId,
      );
    consequences.push(
      locator.kind === "repository" || sourceCheckout
        ? "Link branch on GitHub"
        : "Local branch only",
    );
  } else {
    consequences.push(`Use ${branch}`);
    const hasWorktree =
      item.branch?.branch === branch &&
      item.branch.placements.some((p) => p.workspace && (!hostId || p.hostId === hostId));
    consequences.push(hasWorktree ? "Use existing worktree" : "Create worktree");
  }
  consequences.push(
    hostId ? `On ${options.hosts?.[hostId]?.name ?? hostId}` : "Use project placement",
  );
  const writeBack = locator.kind === "tracked" ? discoveryWriteBackHint(issue, sourceScope) : null;
  if (writeBack) consequences.push(writeBack);
  if (instruction)
    consequences.push(
      "If a session already exists, your instruction stays a draft instead of being sent.",
    );
  return {
    kind: "start",
    label: instruction ? "Start and send" : "Start session",
    consequences,
    locator,
    request: {
      ...(hostId ? { hostId } : {}),
      ...(profileId ? { profileId } : {}),
      ...(instruction ? { prompt: instruction } : {}),
    },
  };
}
