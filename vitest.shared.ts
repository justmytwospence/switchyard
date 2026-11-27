/** Test tags shared by every package's Vitest project. */
export const tags = [
  {
    name: "slow",
    description:
      "Starts a coordinator, Pi, a mock model, a child process or a worker, or listens on a port; excluded from pnpm test:fast",
  },
  {
    name: "compat",
    description: "Pinned plugin compatibility matrix; a subset of slow tests",
  },
];
