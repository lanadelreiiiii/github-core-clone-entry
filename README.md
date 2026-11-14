# github-core-clone-entry

A standalone GitHub-compatible git forge in a single Node 22 process (stdlib only —
no git binary, no install step), built for the make.fun competition
`github-core-clone-01`.

## What it serves

- **Git smart HTTP** — `upload-pack` v2 and v0, `receive-pack` v0, with pkt-line
  framing, sideband-64k, thin-pack, shallow fetch (`deepen`), OFS/REF delta
  resolution, and fast-forward enforcement. Pack read/write uses zlib-wrapped
  deflate, matching the wire format git itself speaks.
- **REST v3** under `/api/v3` — repos, branches, commits, contents, labels,
  issues, comments, pull requests (incl. squash merge + conflict detection),
  with GitHub-style pagination (`Link` headers), `X-GitHub-Request-Id` on
  every reply, and GitHub-faithful status codes (401/404/405/409/422).
- **GraphQL v4** at `/api/graphql` — hand-rolled parser + executor (fields,
  args, variables, aliases, fragments, introspection, batch operations),
  opaque global ids, cursor pagination, and the create/close/merge mutations.
- **MCP** at `/mcp` — JSON-RPC 2.0 over Streamable HTTP, 6 tools
  (`create_repo`, `get_repo`, `create_issue`, `list_issues`,
  `create_pull_request`, `merge_pull_request`), acting on the same store as
  REST/GraphQL/git.

## Layout

| File | Contents |
| --- | --- |
| `main.ts` | Entry lifecycle: bind an ephemeral port, register with `$MAKEFUN_ENV_URL`, poll `/done`, exit 0. |
| `app.ts` | node:http server: routing, auth, git smart-HTTP endpoints, REST/GraphQL/MCP dispatch. |
| `git.ts` | pkt-lines, SHA-1 objects, pack read/write, tree/commit/tag parse/build, reachability, shallow planning. |
| `store.ts` | In-memory store: repos, refs, objects, issues, PRs, labels, viewer learning, merge-base/conflict logic. |
| `rest.ts` | REST v3 handlers. |
| `graphql.ts` | GraphQL parser + executor + mutations. |
| `mcp.ts` | MCP tools + JSON-RPC handling. |

## Run

```sh
node --experimental-strip-types main.ts
# or: node main.ts  (Node 22 type-stripping; erasable TypeScript only)
```

The server binds an ephemeral port and registers it with the environment URL
from `$MAKEFUN_ENV_URL`, exactly as the competition harness expects.

## Local verification

Against the competition's sealed conformance suite (fresh server, local run):

- **Conformance: 120/120** — git 30/30, repos 15/15, issues 15/15,
  pulls 20/20, protocol 5/5, graphql 20/20, mcp 15/15.
- **Perf (local, vs house reference medians):** push 426 ms (ref 1641 ms),
  clone 195 ms (ref 267 ms), read 1541 ms (ref 2760 ms),
  write 177 ms (ref 349 ms) — **153/200 perf points**.
- **Total: 953/1000** locally (feature 600 + agent 200 + perf 153).

## License

MIT — see `LICENSE`.
