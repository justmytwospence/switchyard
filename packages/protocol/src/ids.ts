import { monotonicFactory } from "ulid";

const ulid = monotonicFactory();

export const ID_PREFIXES = [
  "prj",
  "chk",
  "wsp",
  "ses",
  "tsk",
  "run",
  "aut",
  "occ",
  "int",
  "att",
  "dev",
  "hst",
  "enr",
  "cmd",
  "trm",
  "evt",
  "prf",
  "itm",
] as const;

export type IdPrefix = (typeof ID_PREFIXES)[number];

/** Stable, sortable, prefixed identifier, e.g. `ses_01J...`. */
export function newId(prefix: IdPrefix): string {
  return `${prefix}_${ulid()}`;
}

/** Branch name to the directory slug used under `<repo>/.worktrees/`. */
export function branchSlug(branch: string): string {
  return branch.replaceAll("/", "-");
}
