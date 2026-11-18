import {
  GitHubLogin,
  GitHubRepository,
  type Tracker,
  type TrackerInput,
} from "@switchyard/protocol";

/** The tracker form's fields, as typed. */
export interface TrackerDraft {
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
  writeBack: boolean;
  moveShared: boolean;
  enabled: boolean;
}

export type TrackerDraftErrors = Partial<
  Record<"name" | "hostId" | "owner" | "repositories" | "extraRepositories" | "board", string>
>;

const lines = (text: string) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

export function draftOf(t: Tracker | null, defaultHostId: string): TrackerDraft {
  if (!t)
    return {
      name: "",
      hostId: defaultHostId,
      owner: "",
      repositories: "",
      extraRepositories: "",
      board: "",
      statusField: "Status",
      onStart: "",
      onReview: "",
      writeBack: false,
      moveShared: true,
      enabled: true,
    };
  return {
    name: t.name,
    hostId: t.hostId,
    owner: t.owner,
    repositories: (t.repositories ?? []).join("\n"),
    extraRepositories: (t.extraRepositories ?? []).join("\n"),
    board: t.board ? String(t.board.projectNumber) : "",
    statusField: t.board?.statusField ?? "Status",
    onStart: t.board?.onStart ?? "",
    onReview: t.board?.onReview ?? "",
    writeBack: t.writeBack,
    moveShared: t.moveShared,
    enabled: t.enabled,
  };
}

export function validateDraft(d: TrackerDraft): TrackerDraftErrors {
  const e: TrackerDraftErrors = {};
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
  return e;
}

/** The full request body for POST and PATCH. */
export function bodyOf(d: TrackerDraft): TrackerInput {
  const repos = lines(d.repositories);
  const board = d.board.trim();
  return {
    name: d.name.trim(),
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
        }
      : null,
    writeBack: board ? d.writeBack : false,
    moveShared: d.moveShared,
    enabled: d.enabled,
  };
}

/** Label/value rows describing a tracker. */
export function trackerFacts(t: Tracker, hostName: string): [string, string][] {
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
    ["Signed in as", t.login ?? "Not synced yet"],
    ["Host", hostName],
    ["Board", t.board ? `#${t.board.projectNumber}, field ${t.board.statusField}` : "None"],
    ["Moves cards", moves],
  ];
}
