import type {
  IssueBoard,
  IssueDescriptionResult,
  IssueHostSetStatusRequest,
  IssueHostSyncRequest,
  IssuePullRequest,
  IssueSetStatusResult,
  IssueSyncResult,
  SyncedIssue,
} from "@switchyard/protocol";
import {
  ISSUE_DESCRIPTION_MAX_LENGTH,
  IssueDescriptionRequest,
  SwitchyardError,
} from "@switchyard/protocol";

/** Runs `gh` with these arguments and returns its parsed JSON output. */
export type Gh = (args: string[]) => Promise<any>;

const PAGE = 50;
const MAX_PAGES = 4;

// The priority value is read from the item (an unknown field name is null there), never from
// `project.field(name:)`, which makes GitHub return errors for a missing field.
const PRIORITY_VALUE = `priority: fieldValueByName(name:$priorityField){ ... on ProjectV2ItemFieldSingleSelectValue{ name optionId field{ ... on ProjectV2SingleSelectField{ options{id name} } } } }`;

const boardFields = (priority: boolean) => `projectItems(first:20){nodes{ id
  project{ id number owner{ ... on Organization{login} ... on User{login} }
    field(name:$statusField){ ... on ProjectV2SingleSelectField{ id options{id name} } } }
  fieldValueByName(name:$statusField){ ... on ProjectV2ItemFieldSingleSelectValue{ name optionId } }
  ${priority ? PRIORITY_VALUE : ""} }}`;

const ISSUE_FIELDS = `id number title url state repository{nameWithOwner}
      assignees(first:20){nodes{login}}
      linkedBranches(first:10){nodes{ref{name repository{nameWithOwner}}}}
      closedByPullRequestsReferences(first:10,includeClosedPrs:true){nodes{number state url headRefName headRepository{nameWithOwner}}}
      parent{number title url} subIssuesSummary{total completed}`;

function searchQuery(board: boolean, priority: boolean): string {
  const vars = `${board ? ",$statusField:String!" : ""}${board && priority ? ",$priorityField:String!" : ""}`;
  return `query($q:String!,$cursor:String${vars}){ viewer{login}
  search(query:$q,type:ISSUE,first:${PAGE},after:$cursor){ pageInfo{hasNextPage endCursor}
    nodes{ ... on Issue{ ${ISSUE_FIELDS}
      ${board ? boardFields(priority) : ""} }}}}`;
}

const BOARD_MAX_PAGES = 10;
const boardQuery = (
  priority: boolean,
) => `query($owner:String!,$number:Int!,$cursor:String,$statusField:String!,$q:String!${priority ? ",$priorityField:String!" : ""}){ viewer{login}
  repositoryOwner(login:$owner){ ... on ProjectV2Owner{ projectV2(number:$number){ id
    field(name:$statusField){ ... on ProjectV2SingleSelectField{ id options{id name} } }
    items(first:${PAGE},after:$cursor,query:$q){ pageInfo{hasNextPage endCursor}
      nodes{ id
        fieldValueByName(name:$statusField){ ... on ProjectV2ItemFieldSingleSelectValue{ name optionId } }
        ${priority ? PRIORITY_VALUE : ""}
        content{ ... on Issue{ ${ISSUE_FIELDS} } } }}}}}}`;

/** The search string for a GitHub source: the host user's open assigned issues. */
export function issueSearch(req: Pick<IssueHostSyncRequest, "owner" | "repositories">): string {
  const scope = req.repositories
    ? req.repositories.map((r) => `repo:${r}`).join(" ")
    : `user:${req.owner}`;
  return `${scope} is:issue is:open assignee:@me`;
}

function graphqlArgs(query: string, vars: Record<string, string | number | undefined>): string[] {
  const args = ["api", "--hostname", "github.com", "graphql", "-f", `query=${query}`];
  for (const [k, v] of Object.entries(vars)) {
    if (v !== undefined) args.push(typeof v === "number" ? "-F" : "-f", `${k}=${v}`);
  }
  return args;
}

async function graphql(gh: Gh, query: string, vars: Record<string, string | number | undefined>) {
  const raw = await gh(graphqlArgs(query, vars));
  if (raw?.errors?.length)
    throw new Error(String(raw.errors[0]?.message ?? "GitHub GraphQL error"));
  return raw?.data;
}

/** Read one issue body without syncing or mutating its source. */
export async function describeIssue(
  gh: Gh,
  input: IssueDescriptionRequest,
): Promise<IssueDescriptionResult> {
  const req = IssueDescriptionRequest.parse(input);
  const [owner, name] = req.repository.split("/");
  const data = await graphql(
    gh,
    "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){body}}}",
    { owner, name, number: req.number },
  );
  if (data?.repository?.issue === null)
    throw new SwitchyardError("not_found", "Issue not found on GitHub");
  const body = data?.repository?.issue?.body;
  if (typeof body !== "string") throw new Error("Invalid GitHub issue description response");
  if (body.length <= ISSUE_DESCRIPTION_MAX_LENGTH) return { body, truncated: false };
  let end = ISSUE_DESCRIPTION_MAX_LENGTH;
  if (
    body.charCodeAt(end - 1) >= 0xd800 &&
    body.charCodeAt(end - 1) <= 0xdbff &&
    body.charCodeAt(end) >= 0xdc00 &&
    body.charCodeAt(end) <= 0xdfff
  )
    end--;
  return { body: body.slice(0, end), truncated: true };
}

const same = (a: unknown, b: string) =>
  typeof a === "string" && a.toLowerCase() === b.toLowerCase();
const nodes = (v: any): any[] => (Array.isArray(v?.nodes) ? v.nodes.filter(Boolean) : []);

/** The rank of a priority value among its field's options (first option first). */
function priorityOf(value: any): { name: string; rank: number } | null {
  if (typeof value?.name !== "string" || !value.name) return null;
  const options: any[] = Array.isArray(value.field?.options) ? value.field.options : [];
  const index = options.findIndex((o) => o?.id === value.optionId);
  return { name: value.name.slice(0, 200), rank: index >= 0 ? index : options.length };
}

/** A board card from a project (with its status field) and one of its items. */
function boardItem(project: any, item: any): IssueBoard | null {
  const field = project?.field;
  if (!field?.id || !item?.id || !project?.id) return null;
  const value = item.fieldValueByName;
  return {
    projectId: project.id,
    projectItemId: item.id,
    fieldId: field.id,
    status: typeof value?.name === "string" ? value.name : null,
    statusOptionId: typeof value?.optionId === "string" ? value.optionId : null,
    options: (Array.isArray(field.options) ? field.options : [])
      .filter((o: any) => typeof o?.id === "string" && typeof o?.name === "string" && o.name)
      .slice(0, 50)
      .map((o: any) => ({ id: o.id, name: o.name })),
    priority: priorityOf(item.priority),
  };
}

function boardOf(issue: any, req: IssueHostSyncRequest): IssueBoard | null {
  if (!req.board) return null;
  for (const item of nodes(issue.projectItems)) {
    const project = item.project;
    if (project?.number !== req.board.projectNumber) continue;
    if (!same(project?.owner?.login, req.owner)) continue;
    const found = boardItem(project, item);
    if (found) return found;
  }
  return null;
}

/**
 * Whether a card waits in a backlog column: in one of `backlog`, with no branch GitHub knows of
 * and no closing pull request. Such cards are not tracked until work starts.
 */
export function issueWaiting(
  item: Pick<SyncedIssue, "board" | "branches" | "pullRequest">,
  backlog: string[],
): boolean {
  const status = item.board?.status;
  return (
    !!status &&
    backlog.some((b) => same(status, b)) &&
    item.branches.length === 0 &&
    item.pullRequest === null
  );
}

function itemOf(issue: any, board: IssueBoard | null): SyncedIssue | null {
  if (typeof issue?.id !== "string" || typeof issue.number !== "number") return null;
  const repository: string = issue.repository?.nameWithOwner;
  if (typeof repository !== "string") return null;
  const prs = nodes(issue.closedByPullRequestsReferences).filter((p) =>
    same(p.headRepository?.nameWithOwner, repository),
  );
  const branches: string[] = [];
  const add = (b: unknown) => {
    if (typeof b === "string" && b && !branches.includes(b)) branches.push(b);
  };
  for (const lb of nodes(issue.linkedBranches)) {
    if (same(lb.ref?.repository?.nameWithOwner, repository)) add(lb.ref?.name);
  }
  for (const pr of prs) if (pr.state === "OPEN") add(pr.headRefName);
  const chosen = prs.find((p) => p.state === "OPEN") ?? prs.find((p) => p.state === "MERGED");
  const pullRequest: IssuePullRequest | null = chosen
    ? {
        number: chosen.number,
        state: chosen.state,
        url: chosen.url,
        headRefName: chosen.headRefName,
      }
    : null;
  return {
    itemId: issue.id,
    repository,
    number: issue.number,
    title: String(issue.title ?? "").slice(0, 1000) || `${repository} #${issue.number}`,
    url: issue.url,
    assignees: nodes(issue.assignees)
      .map((a) => a.login)
      .filter((l): l is string => typeof l === "string")
      .slice(0, 20),
    branches: branches.slice(0, 10),
    pullRequest,
    board,
    parent:
      typeof issue.parent?.number === "number" && typeof issue.parent.url === "string"
        ? {
            number: issue.parent.number,
            title: String(issue.parent.title ?? "").slice(0, 300),
            url: issue.parent.url,
          }
        : null,
    subIssues:
      typeof issue.subIssuesSummary?.total === "number" && issue.subIssuesSummary.total > 0
        ? {
            total: issue.subIssuesSummary.total,
            completed: Number(issue.subIssuesSummary.completed) || 0,
          }
        : null,
  };
}

/**
 * Every open issue on the source's board, whoever is assigned; `repositories` is ignored, the
 * coordinator filters by scope. Cards waiting in a backlog column are left out.
 */
async function boardSync(gh: Gh, req: IssueHostSyncRequest): Promise<IssueSyncResult> {
  const board = req.board!;
  const items: SyncedIssue[] = [];
  let login = "";
  let cursor: string | undefined;
  let truncated = false;
  for (let page = 0; page < BOARD_MAX_PAGES; page++) {
    const data = await graphql(gh, boardQuery(!!board.priorityField), {
      owner: req.owner,
      number: board.projectNumber,
      cursor,
      statusField: board.statusField,
      ...(board.priorityField ? { priorityField: board.priorityField } : {}),
      q: "is:open is:issue",
    });
    login = data?.viewer?.login ?? login;
    const project = data?.repositoryOwner?.projectV2;
    if (!project?.id) throw new Error(`${req.owner} has no Projects board #${board.projectNumber}`);
    if (!project.field?.id)
      throw new Error(
        `Board #${board.projectNumber} has no single-select field named ${board.statusField}`,
      );
    for (const node of nodes(project.items)) {
      if (node.content?.state !== "OPEN") continue;
      const item = itemOf(node.content, boardItem(project, node));
      if (item && !issueWaiting(item, req.backlog ?? [])) items.push(item);
    }
    const info = project.items?.pageInfo;
    if (!info?.hasNextPage || typeof info.endCursor !== "string") break;
    cursor = info.endCursor;
    if (page === BOARD_MAX_PAGES - 1) truncated = true;
  }
  if (!login) throw new Error("GitHub did not report the signed-in user");
  return { login, items: items.slice(0, 200), truncated: truncated || items.length > 200 };
}

/**
 * The source's open issues (assigned to the host user, or every open issue on its board), with
 * linked branches, closing PRs and board columns, minus cards waiting in a backlog column.
 */
export async function syncIssues(gh: Gh, req: IssueHostSyncRequest): Promise<IssueSyncResult> {
  if (req.follow === "board" && req.board) return boardSync(gh, req);
  const q = issueSearch(req);
  const query = searchQuery(req.board !== null, !!req.board?.priorityField);
  const items: SyncedIssue[] = [];
  let login = "";
  let cursor: string | undefined;
  let truncated = false;
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await graphql(gh, query, {
      q,
      cursor,
      ...(req.board ? { statusField: req.board.statusField } : {}),
      ...(req.board?.priorityField ? { priorityField: req.board.priorityField } : {}),
    });
    login = data?.viewer?.login ?? login;
    for (const node of nodes(data?.search)) {
      const item = itemOf(node, boardOf(node, req));
      if (item && !issueWaiting(item, req.backlog ?? [])) items.push(item);
    }
    const info = data?.search?.pageInfo;
    if (!info?.hasNextPage || typeof info.endCursor !== "string") break;
    cursor = info.endCursor;
    if (page === MAX_PAGES - 1) truncated = true;
  }
  if (!login) throw new Error("GitHub did not report the signed-in user");
  return { login, items: items.slice(0, 200), truncated };
}

const ITEM_QUERY = `query($item:ID!,$statusField:String!){ node(id:$item){ ... on ProjectV2Item{
  content{ ... on Issue{ assignees(first:20){nodes{login}} } }
  fieldValueByName(name:$statusField){ ... on ProjectV2ItemFieldSingleSelectValue{ optionId } } } } }`;
const MOVE = `mutation($project:ID!,$item:ID!,$field:ID!,$option:String!){
  updateProjectV2ItemFieldValue(input:{projectId:$project,itemId:$item,fieldId:$field,value:{singleSelectOptionId:$option}}){projectV2Item{id}} }`;

/**
 * Move a board card, only when it is still assigned to `login` (and to nobody else unless
 * `allowShared`), or assigned to nobody when `allowUnassigned`, and still in the column the
 * caller last saw.
 */
export async function setIssueStatus(
  gh: Gh,
  req: IssueHostSetStatusRequest,
): Promise<IssueSetStatusResult> {
  const data = await graphql(gh, ITEM_QUERY, {
    item: req.projectItemId,
    statusField: req.statusField,
  });
  const node = data?.node;
  const assignees = nodes(node?.content?.assignees).map((a) => a.login);
  const mine = assignees.some((a) => same(a, req.login));
  if (!mine && !(req.allowUnassigned && assignees.length === 0))
    return { status: "skipped", reason: "not_assigned" };
  if (mine && assignees.length > 1 && !req.allowShared)
    return { status: "skipped", reason: "shared" };
  const current = node?.fieldValueByName?.optionId ?? null;
  if (current !== req.expectedOptionId) return { status: "skipped", reason: "stale" };
  await graphql(gh, MOVE, {
    project: req.projectId,
    item: req.projectItemId,
    field: req.fieldId,
    option: req.optionId,
  });
  return { status: "moved" };
}
