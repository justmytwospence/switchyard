import {
  GitHubLogin,
  GitHubRepository,
  type GitHubSource,
  type GitHubSourceInput,
  type Scope,
  sourceBacklog,
  sourceFollow,
  sourceMakesWorktrees,
} from "@switchyard/protocol";

/** The GitHub scope form's fields, as typed. */
export interface GitHubSourceDraft {
  name: string;
  hostId: string;
  owner: string;
  /** One owner/name per line; empty: every repository of the owner. */
  repositories: string;
  /** One owner/name per line: repositories of other owners. */
  extraRepositories: string;
  /** A Projects board number; empty: none. */
  board: string;
  statusField: string;
  onStart: string;
  onReview: string;
  /** Which issues to follow. */
  follow: "assigned" | "board";
  /** Backlog columns, comma-separated. */
  backlog: string;
  /** The board's priority field; empty: none. */
  priorityField: string;
  writeBack: boolean;
  moveShared: boolean;
  worktrees: boolean;
  enabled: boolean;
}

export type GitHubSourceDraftErrors = Partial<
  Record<
    "name" | "hostId" | "owner" | "repositories" | "extraRepositories" | "board" | "backlog",
    string
  >
>;

const backlogOf = (text: string) =>
  text
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const lines = (text: string) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

/** The draft for a new GitHub scope (`scope` null), or for a scope's source (none yet: defaults). */
export function draftOf(scope: Scope | null, defaultHostId: string): GitHubSourceDraft {
  const t = scope?.source ?? null;
  if (!t)
    return {
      name: scope?.name ?? "",
      hostId: defaultHostId,
      owner: "",
      repositories: "",
      extraRepositories: "",
      board: "",
      statusField: "Status",
      onStart: "",
      onReview: "",
      follow: "assigned",
      backlog: "",
      priorityField: "",
      writeBack: false,
      moveShared: true,
      worktrees: true,
      enabled: true,
    };
  return {
    name: scope?.name ?? "",
    hostId: t.hostId,
    owner: t.owner,
    repositories: (t.repositories ?? []).join("\n"),
    extraRepositories: (t.extraRepositories ?? []).join("\n"),
    board: t.board ? String(t.board.projectNumber) : "",
    statusField: t.board?.statusField ?? "Status",
    onStart: t.board?.onStart ?? "",
    onReview: t.board?.onReview ?? "",
    follow: sourceFollow(t),
    backlog: sourceBacklog(t).join(", "),
    priorityField: t.board?.priorityField ?? "",
    writeBack: t.writeBack,
    moveShared: t.moveShared,
    worktrees: sourceMakesWorktrees(t),
    enabled: t.enabled,
  };
}

export function validateDraft(d: GitHubSourceDraft): GitHubSourceDraftErrors {
  const e: GitHubSourceDraftErrors = {};
  const name = d.name.trim();
  if (!name) e.name = "Enter a name.";
  else if (name.length > 60) e.name = "Use 60 characters or fewer.";
  if (!d.hostId) e.hostId = "Choose a host.";
  if (!GitHubLogin.safeParse(d.owner.trim()).success)
    e.owner = "Enter a GitHub organization or user name.";
  if (lines(d.repositories).some((r) => !GitHubRepository.safeParse(r).success))
    e.repositories = "Use owner/name, one per line.";
  const extra = lines(d.extraRepositories);
  if (extra.some((r) => !GitHubRepository.safeParse(r).success))
    e.extraRepositories = "Use owner/name, one per line.";
  else if (extra.length > 20) e.extraRepositories = "Use 20 repositories or fewer.";
  const board = d.board.trim();
  if (board && !/^[1-9][0-9]*$/.test(board)) e.board = "Enter the board's number, as in its URL.";
  if (backlogOf(d.backlog).length > 20) e.backlog = "Use 20 columns or fewer.";
  return e;
}

/** The full request body for POST and PATCH /api/scopes: the scope's name and its source. */
export function bodyOf(d: GitHubSourceDraft): { name: string; source: GitHubSourceInput } {
  const repos = lines(d.repositories);
  const board = d.board.trim();
  const source: GitHubSourceInput = {
    hostId: d.hostId,
    owner: d.owner.trim(),
    repositories: repos.length ? repos : null,
    extraRepositories: lines(d.extraRepositories),
    board: board
      ? {
          projectNumber: Number(board),
          statusField: d.statusField.trim() || "Status",
          onStart: d.onStart.trim() || null,
          onReview: d.onReview.trim() || null,
          backlog: backlogOf(d.backlog),
          priorityField: d.priorityField.trim() || null,
        }
      : null,
    follow: board ? d.follow : "assigned",
    writeBack: board ? d.writeBack : false,
    moveShared: d.moveShared,
    worktrees: d.worktrees,
    enabled: d.enabled,
  };
  return { name: d.name.trim(), source };
}

/** Label/value rows describing a scope's GitHub source. */
export function sourceFacts(t: GitHubSource, hostName: string): [string, string][] {
  const moves = (() => {
    if (!t.writeBack || !t.board) return "Off";
    const parts = [
      t.board.onStart ? `To "${t.board.onStart}" when work starts` : null,
      t.board.onReview
        ? `${t.board.onStart ? "to" : "To"} "${t.board.onReview}" when a pull request opens`
        : null,
    ].filter((p): p is string => !!p);
    if (parts.length === 0) return "On, but no columns are set";
    return `${parts.join(", ")}${t.moveShared ? "" : "; never shared cards"}`;
  })();
  return [
    [
      "GitHub",
      `${t.owner}${t.repositories ? `: ${t.repositories.join(", ")}` : " (all repositories)"}${
        t.extraRepositories?.length ? `, plus ${t.extraRepositories.join(", ")}` : ""
      }`,
    ],
    [
      "Follows",
      sourceFollow(t) === "board"
        ? "Every open issue on the board"
        : `Issues assigned to ${t.login ?? "you"}`,
    ],
    ["Signed in as", t.login ?? "Not synced yet"],
    ["Host", hostName],
    [
      "Board",
      t.board
        ? `#${t.board.projectNumber}, field ${t.board.statusField}${
            t.board.priorityField ? `, priority ${t.board.priorityField}` : ""
          }${sourceBacklog(t).length ? `; hides ${sourceBacklog(t).join(", ")} until started` : ""}`
        : "None",
    ],
    ["Moves cards", moves],
  ];
}
