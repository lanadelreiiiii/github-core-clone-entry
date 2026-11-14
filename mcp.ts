// mcp.ts — Model Context Protocol endpoint (Streamable HTTP, revision 2026-07-28).
// JSON-RPC 2.0 over POST /mcp. Tools act on the same store as REST; every tool result
// carries both a text JSON block and structuredContent.

import { mergePullRequestInternal } from './graphql.ts';
import { diffTrees, mergeConflicts, type Issue, type PullRequest, type Repo, type Store } from './store.ts';

export const MCP_SERVER_NAME = 'github-core-clone';
export const MCP_SERVER_VERSION = '1.0.0';
export const MCP_REVISIONS = ['2026-07-28', '2025-11-25', '2025-06-18'];

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

export const MCP_TOOLS: McpToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner ?? ''}/${repo.name}`,
    owner: { login: repo.owner ?? '', id: 1, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
  };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((l) => ({ name: l.name, color: l.color })),
    user: { login: issue.userLogin, id: 1, type: 'User' },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    url: `https://example.invalid/${repo.owner ?? ''}/${repo.name}/issues/${issue.number}`,
  };
}

export function pullJson(repo: Repo, pull: PullRequest): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner ?? ''}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner ?? ''}:${pull.baseRef}` },
    user: { login: pull.userLogin, id: 1, type: 'User' },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    url: `https://example.invalid/${repo.owner ?? ''}/${repo.name}/pull/${pull.number}`,
  };
}

interface ToolOutcome {
  ok: boolean;
  result: Record<string, unknown> | null;
  errorMessage: string | null;
}

function missingArgs(tool: McpToolDef, args: Record<string, unknown>): string[] {
  return tool.inputSchema.required.filter((name) => args[name] === undefined || args[name] === null || args[name] === '');
}

export function callMcpTool(store: Store, name: string, args: Record<string, unknown>): ToolOutcome {
  const tool = MCP_TOOLS.find((t) => t.name === name);
  if (tool === undefined) return { ok: false, result: null, errorMessage: `unknown tool ${name}` };
  const missing = missingArgs(tool, args);
  if (missing.length > 0) {
    return { ok: false, result: null, errorMessage: `missing required argument(s): ${missing.join(', ')}` };
  }
  try {
    switch (name) {
      case 'create_repo': {
        const repoName = String(args.name);
        const { repo, duplicate } = store.createRepo(repoName, typeof args.description === 'string' ? args.description : '', args.private === true);
        if (repo === null || duplicate) return { ok: false, result: null, errorMessage: `repository ${repoName} already exists` };
        return { ok: true, result: repoJson(repo), errorMessage: null };
      }
      case 'get_repo': {
        const repo = store.resolveRepo(String(args.owner), String(args.repo));
        if (repo === null) return { ok: false, result: null, errorMessage: 'repository not found' };
        return { ok: true, result: repoJson(repo), errorMessage: null };
      }
      case 'create_issue': {
        const repo = store.resolveRepo(String(args.owner), String(args.repo));
        if (repo === null) return { ok: false, result: null, errorMessage: 'repository not found' };
        const issue: Issue = {
          id: store.nextId(),
          number: repo.nextIssue++,
          title: String(args.title),
          body: typeof args.body === 'string' ? args.body : '',
          state: 'open',
          labels: [],
          userLogin: store.viewerLogin ?? '',
          comments: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          closedAt: null,
        };
        repo.issues.push(issue);
        return { ok: true, result: issueJson(repo, issue), errorMessage: null };
      }
      case 'list_issues': {
        const repo = store.resolveRepo(String(args.owner), String(args.repo));
        if (repo === null) return { ok: false, result: null, errorMessage: 'repository not found' };
        const state = typeof args.state === 'string' ? args.state.toLowerCase() : 'open';
        const list = state === 'all' ? repo.issues : repo.issues.filter((i) => i.state === state);
        return { ok: true, result: { issues: list.map((i) => issueJson(repo, i)) }, errorMessage: null };
      }
      case 'create_pull_request': {
        const repo = store.resolveRepo(String(args.owner), String(args.repo));
        if (repo === null) return { ok: false, result: null, errorMessage: 'repository not found' };
        const head = String(args.head);
        const base = String(args.base);
        const headSha = repo.refs.get(`refs/heads/${head}`);
        const baseSha = repo.refs.get(`refs/heads/${base}`);
        if (headSha === undefined || baseSha === undefined) {
          return { ok: false, result: null, errorMessage: 'head or base branch not found' };
        }
        const duplicate = repo.pulls.find((p) => p.state === 'open' && p.headRef === head && p.baseRef === base);
        if (duplicate !== undefined) return { ok: false, result: null, errorMessage: 'a pull request already exists for this head branch' };
        const pull: PullRequest = {
          id: store.nextId(),
          number: repo.nextPull++,
          title: String(args.title),
          body: typeof args.body === 'string' ? args.body : '',
          state: 'open',
          headRef: head,
          headSha,
          baseRef: base,
          baseSha,
          userLogin: store.viewerLogin ?? '',
          merged: false,
          mergedAt: null,
          mergeCommitSha: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        repo.pulls.push(pull);
        return { ok: true, result: pullJson(repo, pull), errorMessage: null };
      }
      case 'merge_pull_request': {
        const repo = store.resolveRepo(String(args.owner), String(args.repo));
        if (repo === null) return { ok: false, result: null, errorMessage: 'repository not found' };
        const number = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
        const pull = repo.pulls.find((p) => p.number === number);
        if (pull === undefined) return { ok: false, result: null, errorMessage: 'pull request not found' };
        if (pull.merged || pull.state !== 'open') return { ok: false, result: null, errorMessage: 'pull request is already closed' };
        if (mergeConflicts(repo, pull.baseSha, pull.headSha)) {
          return { ok: false, result: null, errorMessage: 'pull request has merge conflicts' };
        }
        const merged = mergePullRequestInternal(repo, pull);
        if (merged === null) return { ok: false, result: null, errorMessage: 'merge failed' };
        return { ok: true, result: pullJson(repo, merged), errorMessage: null };
      }
      default:
        return { ok: false, result: null, errorMessage: `unknown tool ${name}` };
    }
  } catch (err) {
    return { ok: false, result: null, errorMessage: err instanceof Error ? err.message : String(err) };
  }
}

// Re-exported for the REST layer's pull files view.
export { diffTrees };
