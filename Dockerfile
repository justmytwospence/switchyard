# Switchyard coordinator image (hub mode). Build from the repo root:
#   docker build -t switchyard:latest .
#
# By default the image runs only the coordinator. Pi never runs in the coordinator: host agents
# run it on the machines that own the repositories and credentials, and connect outbound. The
# coordinator needs no Docker socket, no home directory mount and no Pi. The same image can also
# run a host agent (`switchyard host run`) as a host container whose home is the machine's own.

# ---- build: install everything, compile every package and the web bundle ----------------------
FROM node:26-bookworm-slim@sha256:bc0a2afd3b74ce12222fc8bab99271e66257f021078f5f4a5d687a77d280c1d9 AS build

# Node 25+ no longer bundles corepack; install it so the pnpm pinned in package.json is used.
RUN npm install -g corepack@latest && corepack enable

ENV PNPM_HOME=/pnpm \
    npm_config_store_dir=/pnpm/store \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /app

# node-pty (terminal sessions) has no Linux prebuilds: it compiles during install.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

COPY . .

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile
# `tsc -b` for every TS package, then the Vite bundle into packages/web/dist.
RUN pnpm build

# Production tree without `pnpm deploy`: workspace `dist/` directories are gitignored and the
# packages have no `files` field, so a pack-based deploy would drop them. Instead drop the dev
# install and reinstall only the CLI's production dependency closure; the workspace links stay
# relative, so the tree can be copied as is.
RUN rm -rf node_modules packages/*/node_modules
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    CI=true pnpm install --frozen-lockfile --prod --filter "@switchyard/cli..."

# ---- runtime ----------------------------------------------------------------------------------
FROM node:26-bookworm-slim@sha256:bc0a2afd3b74ce12222fc8bab99271e66257f021078f5f4a5d687a77d280c1d9 AS runtime

# git (and ssh for git remotes) for the host-agent role: the same image runs a host agent as a
# host container that mounts the user's home, where it manages worktrees and runs Pi from the mounted
# home. The coordinator role does not use them.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates openssh-client \
 && rm -rf /var/lib/apt/lists/*

LABEL org.opencontainers.image.source="https://github.com/justmytwospence/switchyard"

ENV NODE_ENV=production \
    SWITCHYARD_WEB_DIST=/app/packages/web/dist \
    SWITCHYARD_DATA_DIR=/data
WORKDIR /app

COPY --from=build --chown=node:node /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules

# Each workspace package needs its manifest (`exports` point at dist), compiled dist and links.
COPY --from=build --chown=node:node /app/packages/protocol/package.json /app/packages/protocol/package.json
COPY --from=build --chown=node:node /app/packages/protocol/dist /app/packages/protocol/dist
COPY --from=build --chown=node:node /app/packages/protocol/node_modules /app/packages/protocol/node_modules

# pi-runtime's dist contains the compiled bridge extension.
COPY --from=build --chown=node:node /app/packages/pi-runtime/package.json /app/packages/pi-runtime/package.json
COPY --from=build --chown=node:node /app/packages/pi-runtime/dist /app/packages/pi-runtime/dist
COPY --from=build --chown=node:node /app/packages/pi-runtime/node_modules /app/packages/pi-runtime/node_modules

COPY --from=build --chown=node:node /app/packages/adapter-sdk/package.json /app/packages/adapter-sdk/package.json
COPY --from=build --chown=node:node /app/packages/adapter-sdk/dist /app/packages/adapter-sdk/dist
COPY --from=build --chown=node:node /app/packages/adapter-sdk/node_modules /app/packages/adapter-sdk/node_modules

COPY --from=build --chown=node:node /app/packages/host-agent/package.json /app/packages/host-agent/package.json
COPY --from=build --chown=node:node /app/packages/host-agent/dist /app/packages/host-agent/dist
COPY --from=build --chown=node:node /app/packages/host-agent/node_modules /app/packages/host-agent/node_modules

COPY --from=build --chown=node:node /app/packages/coordinator/package.json /app/packages/coordinator/package.json
COPY --from=build --chown=node:node /app/packages/coordinator/dist /app/packages/coordinator/dist
COPY --from=build --chown=node:node /app/packages/coordinator/node_modules /app/packages/coordinator/node_modules

COPY --from=build --chown=node:node /app/packages/terminal/package.json /app/packages/terminal/package.json
COPY --from=build --chown=node:node /app/packages/terminal/dist /app/packages/terminal/dist
COPY --from=build --chown=node:node /app/packages/terminal/node_modules /app/packages/terminal/node_modules

COPY --from=build --chown=node:node /app/packages/cli/package.json /app/packages/cli/package.json
COPY --from=build --chown=node:node /app/packages/cli/dist /app/packages/cli/dist
COPY --from=build --chown=node:node /app/packages/cli/node_modules /app/packages/cli/node_modules

# The web bundle served by the coordinator (SWITCHYARD_WEB_DIST).
COPY --from=build --chown=node:node /app/packages/web/dist /app/packages/web/dist

# `switchyard` on PATH, for `docker exec` (pair, backup) and the host role.
RUN ln -s /app/packages/cli/dist/main.js /usr/local/bin/switchyard \
 && chmod +x /app/packages/cli/dist/main.js

# Persistent state: coordinator.db, admin.token and coordinator.lock live here.
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 7400
VOLUME /data

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:7400/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["node", "/app/packages/cli/dist/main.js"]
CMD ["coordinator", "start", "--data-dir", "/data", "--listen", "0.0.0.0:7400"]
