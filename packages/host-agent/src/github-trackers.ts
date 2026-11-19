import type {
  TrackerHostSetStatusRequest,
  TrackerHostSyncRequest,
  TrackerItem,
  TrackerItemBoard,
  TrackerPullRequest,
  TrackerSetStatusResult,
  TrackerSyncResult,
} from "@switchyard/protocol";

/** Runs `gh` with these arguments and returns its parsed JSON output. */
export type Gh = (args: string[]) => Promise<any>;

const PAGE = 50;
const MAX_PAGES = 4;

const BOARD_FIELDS = `projectItems(first:20){nodes{ id
  project{ id number owner{ ... on Organization{login} ... on User{login} }
    field(name:$statusField){ ... on ProjectV2SingleSelectField{ id options{id name} } } }
  fieldValueByName(name:$statusField){ ... on ProjectV2ItemFieldSingleSelectValue{ name optionId } } }}`;

const ISSUE_FIELDS = `id number title url state repository{nameWithOwner}
      assignees(first:20){nodes{login}}
      linkedBranches(first:10){nodes{ref{name repository{nameWithOwner}}}}
      closedByPullRequestsReferences(first:10,includeClosedPrs:true){nodes{number state url headRefName headRepository{nameWithOwner}}}`;

function searchQuery(board: boolean): string {
  return `query($q:String!,$cursor:String${board ? ",$statusField:String!" : ""}){ viewer{login}
  search(query:$q,type:ISSUE,first:${PAGE},after:$cursor){ pageInfo{hasNextPage endCursor}
    nodes{ ... on Issue{ ${ISSUE_FIELDS}
      ${board ? BOARD_FIELDS : ""} }}}}`;
}

const BOARD_MAX_PAGES = 10;
const BOARD_QUERY = `query($owner:String!,$number:Int!,$cursor:String,$statusField:String!,$q:String!){ viewer{login}
  repositoryOwner(login:$owner){ ... on ProjectV2Owner{ projectV2(number:$number){ id
    field(name:$statusField){ ... on ProjectV2SingleSelectField{ id options{id name} } }
    items(first:${PAGE},after:$cursor,query:$q){ pageInfo{hasNextPage endCursor}
      nodes{ id
        fieldValueByName(name:$statusField){ ... on ProjectV2ItemFieldSingleSelectValue{ name optionId } }
        content{ ... on Issue{ ${ISSUE_FIELDS} } } }}}}}}`;

/** The search string for a tracker's scope: the host user's open assigned issues. */
export function trackerSearch(req: Pick<TrackerHostSyncRequest, "owner" | "repositories">): string {
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

const same = (a: unknown, b: string) =>
  typeof a === "string" && a.toLowerCase() === b.toLowerCase();
const nodes = (v: any): any[] => (Array.isArray(v?.nodes) ? v.nodes.filter(Boolean) : []);

/** A board card from a project (with its status field) and one of its items. */
function boardItem(project: any, item: any): TrackerItemBoard | null {
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
  };
}

function boardOf(issue: any, req: TrackerHostSyncRequest): TrackerItemBoard | null {
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
export function trackerItemWaiting(
  item: Pick<TrackerItem, "board" | "branches" | "pullRequest">,
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

function itemOf(issue: any, board: TrackerItemBoard | null): TrackerItem | null {
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
  const pullRequest: TrackerPullRequest | null = chosen
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
  };
}

/**
 * Every open issue on the tracker's board, whoever is assigned; `repositories` is ignored, the
 * coordinator filters by scope. Cards waiting in a backlog column are left out.
 */
async function trackerBoardSync(gh: Gh, req: TrackerHostSyncRequest): Promise<TrackerSyncResult> {
  const board = req.board!;
  const items: TrackerItem[] = [];
  let login = "";
  let cursor: string | undefined;
  let truncated = false;
  for (let page = 0; page < BOARD_MAX_PAGES; page++) {
    const data = await graphql(gh, BOARD_QUERY, {
      owner: req.owner,
      number: board.projectNumber,
      cursor,
      statusField: board.statusField,
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
      if (item && !trackerItemWaiting(item, req.backlog ?? [])) items.push(item);
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
 * The tracker's open issues (assigned to the host user, or every open issue on its board), with
 * linked branches, closing PRs and board columns, minus cards waiting in a backlog column.
 */
export async function trackerSync(gh: Gh, req: TrackerHostSyncRequest): Promise<TrackerSyncResult> {
  if (req.follow === "board" && req.board) return trackerBoardSync(gh, req);
  const q = trackerSearch(req);
  const query = searchQuery(req.board !== null);
  const items: TrackerItem[] = [];
  let login = "";
  let cursor: string | undefined;
  let truncated = false;
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await graphql(gh, query, {
      q,
      cursor,
      ...(req.board ? { statusField: req.board.statusField } : {}),
    });
    login = data?.viewer?.login ?? login;
    for (const node of nodes(data?.search)) {
      const item = itemOf(node, boardOf(node, req));
      if (item && !trackerItemWaiting(item, req.backlog ?? [])) items.push(item);
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
export async function trackerSetStatus(
  gh: Gh,
  req: TrackerHostSetStatusRequest,
): Promise<TrackerSetStatusResult> {
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
