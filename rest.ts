// rest.ts — GitHub REST v3 surface: repositories, branches, commits, contents,
// labels, issues, comments and pull requests. All state lives in the store; every
// reply is JSON with a non-empty X-GitHub-Request-Id.

import { parseCommit } from './git.ts';
import { issueJson, pullJson, repoJson } from './mcp.ts';
import {
  commitFileChange,
  diffTrees,
  isAncestor,
  listCommits,
  listTreeDir,
  mergeConflicts,
  treeLookup,
  type Issue,
  type PullRequest,
  type Repo,
  type Store,
} from './store.ts';
import { mergePullRequestInternal } from './graphql.ts';

export interface RestContext {
  store: Store;
  method: string;
  segments: string[];
  query: URLSearchParams;
  body: unknown;
  baseUrl: string; // absolute origin for pagination links, e.g. http://127.0.0.1:1234
}

export type RestReply =
  | { status: number; body: unknown; headers?: Record<string, string> }
  | { status: number; empty: true; headers?: Record<string, string> };

function err(message: string): { message: string } {
  return { message };
}

function pagination(query: URLSearchParams): { page: number; perPage: number } {
  const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
  const perPage = Math.min(100, Math.max(1, Number(query.get('per_page') ?? '30') || 30));
  return { page, perPage };
}

function pageOf<T>(items: T[], query: URLSearchParams): { items: T[]; total: number; page: number; perPage: number } {
  const { page, perPage } = pagination(query);
  const start = (page - 1) * perPage;
  return { items: items.slice(start, start + perPage), total: items.length, page, perPage };
}

function linkHeader(baseUrl: string, path: string, query: URLSearchParams, page: number, perPage: number, total: number): string | null {
  const last = Math.max(1, Math.ceil(total / perPage));
  if (last <= 1) return null;
  const build = (p: number): string => {
    const q = new URLSearchParams(query);
    q.set('page', String(p));
    q.set('per_page', String(perPage));
    return `<${baseUrl}${path}?${q.toString()}>`;
  };
  const links: string[] = [];
  if (page > 1) links.push(`${build(1)}; rel="first"`, `${build(page - 1)}; rel="prev"`);
  if (page < last) links.push(`${build(page + 1)}; rel="next"`, `${build(last)}; rel="last"`);
  return links.length > 0 ? links.join(', ') : null;
}

function pagedReply<T>(ctx: RestContext, path: string, items: T[]): RestReply {
  const { items: pageItems, total, page, perPage } = pageOf(items, ctx.query);
  const headers: Record<string, string> = {};
  const link = linkHeader(ctx.baseUrl, path, ctx.query, page, perPage, total);
  if (link !== null) headers.link = link;
  return { status: 200, body: pageItems, headers };
}

function bodyRecord(body: unknown): Record<string, unknown> {
  return (body !== null && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
}

function repoUrl(ctx: RestContext, repo: Repo): string {
  return `${ctx.baseUrl}/api/v3/repos/${repo.owner ?? ''}/${repo.name}`;
}

function fullRepoJson(ctx: RestContext, repo: Repo): Record<string, unknown> {
  const base = repoJson(repo);
  return {
    ...base,
    html_url: `https://example.invalid/${repo.owner ?? ''}/${repo.name}`,
    url: repoUrl(ctx, repo),
    fork: false,
    archived: false,
    disabled: false,
    visibility: repo.private ? 'private' : 'public',
    topics: [],
    license: null,
  };
}

function fullIssueJson(ctx: RestContext, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    ...issueJson(repo, issue),
    html_url: `https://example.invalid/${repo.owner ?? ''}/${repo.name}/issues/${issue.number}`,
    url: `${repoUrl(ctx, repo)}/issues/${issue.number}`,
    comments: issue.comments.length,
    closed_at: issue.closedAt,
    assignee: null,
    milestone: null,
  };
}

function fullPullJson(ctx: RestContext, repo: Repo, pull: PullRequest): Record<string, unknown> {
  const currentBase = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  const mergeable = pull.state === 'open' ? !mergeConflicts(repo, currentBase, pull.headSha) : false;
  return {
    ...pullJson(repo, pull),
    html_url: `https://example.invalid/${repo.owner ?? ''}/${repo.name}/pull/${pull.number}`,
    url: `${repoUrl(ctx, repo)}/pulls/${pull.number}`,
    mergeable,
    draft: false,
  };
}

function commitJson(ctx: RestContext, repo: Repo, sha: string): Record<string, unknown> | null {
  const object = repo.objects.get(sha);
  if (object?.type !== 'commit') return null;
  const commit = parseCommit(object.data);
  const authorLine = commit.author;
  const committerLine = commit.committer;
  const parseIdentity = (line: string): { name: string; email: string; date: string } => {
    const match = /^(.*?) <(.*?)> (\d+) ([+-]\d{4})$/.exec(line);
    if (match === null) return { name: line, email: '', date: new Date().toISOString() };
    return {
      name: match[1] ?? '',
      email: match[2] ?? '',
      date: new Date(Number(match[3]) * 1000).toISOString(),
    };
  };
  const author = parseIdentity(authorLine);
  const committer = parseIdentity(committerLine);
  return {
    sha,
    commit: { message: commit.message.replace(/\n$/, ''), author, committer, tree: { sha: commit.tree } },
    parents: commit.parents.map((p) => ({ sha: p })),
    author: { login: author.email.split('@')[0] ?? '', id: 1, type: 'User' },
    committer: { login: committer.email.split('@')[0] ?? '', id: 1, type: 'User' },
    url: `${repoUrl(ctx, repo)}/commits/${sha}`,
  };
}

function resolveRef(repo: Repo, ref: string): string | null {
  // A branch name, a full ref, or a raw oid.
  if (repo.refs.has(`refs/heads/${ref}`)) return repo.refs.get(`refs/heads/${ref}`) ?? null;
  if (repo.refs.has(ref)) return repo.refs.get(ref) ?? null;
  if (/^[0-9a-f]{40}$/.test(ref) && repo.objects.has(ref)) return ref;
  return null;
}

/** Route a REST request. Returns null when the path is not a REST route. */
export function handleRest(ctx: RestContext): RestReply | null {
  const { store, method, segments } = ctx;
  if (segments.length === 0) return null;

  // API root is handled by the server (no auth); meta needs auth (checked by caller).
  if (segments[0] === 'meta' && segments.length === 1) {
    if (method !== 'GET') return { status: 404, body: err('Not Found') };
    return { status: 200, body: { installed_version: '1.0.0' } };
  }

  if (segments[0] === 'user') {
    if (segments.length === 2 && segments[1] === 'repos') {
      if (method === 'GET') {
        const repos = store.listViewerRepos();
        return pagedReply(ctx, '/api/v3/user/repos', repos.map((r) => fullRepoJson(ctx, r)));
      }
      if (method === 'POST') {
        const input = bodyRecord(ctx.body);
        const name = typeof input.name === 'string' ? input.name : '';
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name) || name.endsWith('.git')) {
          return { status: 422, body: err('name is not valid') };
        }
        const { repo, duplicate } = store.createRepo(
          name,
          typeof input.description === 'string' ? input.description : '',
          input.private === true,
        );
        if (duplicate || repo === null) {
          return { status: 422, body: err(`Repository ${name} already exists`) };
        }
        return { status: 201, body: fullRepoJson(ctx, repo) };
      }
      return { status: 404, body: err('Not Found') };
    }
    if (segments.length === 1 && method === 'GET') {
      const login = store.viewerLogin;
      if (login === null) return { status: 404, body: err('Not Found') };
      return {
        status: 200,
        body: {
          login,
          id: 1,
          type: 'User',
          name: login,
          email: `${login}@example.invalid`,
          html_url: `https://example.invalid/${login}`,
          url: `${ctx.baseUrl}/api/v3/users/${login}`,
        },
      };
    }
    return { status: 404, body: err('Not Found') };
  }

  if (segments[0] !== 'repos' || segments.length < 3) return { status: 404, body: err('Not Found') };
  const owner = decodeURIComponent(segments[1]!);
  const repoName = decodeURIComponent(segments[2]!);
  const repo = store.resolveRepo(owner, repoName);
  if (repo === null) return { status: 404, body: err('Not Found') };
  const rest = segments.slice(3);
  const path = `/api/v3/repos/${owner}/${repoName}${rest.length > 0 ? `/${rest.join('/')}` : ''}`;

  // /repos/{o}/{r}
  if (rest.length === 0) {
    if (method === 'GET') return { status: 200, body: fullRepoJson(ctx, repo) };
    if (method === 'PATCH') {
      const input = bodyRecord(ctx.body);
      if (typeof input.description === 'string') repo.description = input.description;
      if (typeof input.private === 'boolean') repo.private = input.private;
      if (typeof input.default_branch === 'string' && repo.refs.has(`refs/heads/${input.default_branch}`)) {
        repo.defaultBranch = input.default_branch;
      }
      repo.updatedAt = new Date().toISOString();
      return { status: 200, body: fullRepoJson(ctx, repo) };
    }
    if (method === 'DELETE') {
      store.deleteRepo(repo);
      return { status: 204, empty: true };
    }
    return { status: 404, body: err('Not Found') };
  }

  // branches
  if (rest[0] === 'branches') {
    if (rest.length === 1 && method === 'GET') {
      const branches = [...repo.refs.keys()]
        .filter((r) => r.startsWith('refs/heads/'))
        .map((r) => r.slice('refs/heads/'.length))
        .sort()
        .map((name) => ({
          name,
          commit: { sha: repo.refs.get(`refs/heads/${name}`) ?? '', url: `${repoUrl(ctx, repo)}/commits/${repo.refs.get(`refs/heads/${name}`) ?? ''}` },
          protected: false,
        }));
      return { status: 200, body: branches };
    }
    if (rest.length === 2 && method === 'GET') {
      const branch = decodeURIComponent(rest[1]!);
      const sha = repo.refs.get(`refs/heads/${branch}`);
      if (sha === undefined) return { status: 404, body: err('Not Found') };
      return { status: 200, body: { name: branch, commit: { sha, url: `${repoUrl(ctx, repo)}/commits/${sha}` }, protected: false } };
    }
    return { status: 404, body: err('Not Found') };
  }

  // commits
  if (rest[0] === 'commits') {
    if (rest.length === 1 && method === 'GET') {
      const ref = ctx.query.get('sha') ?? repo.defaultBranch;
      const tip = resolveRef(repo, ref);
      if (tip === null) return { status: 404, body: err('Not Found') };
      const shas = listCommits(repo, tip, 1000);
      const items = shas.map((sha) => commitJson(ctx, repo, sha)).filter((c): c is Record<string, unknown> => c !== null);
      return pagedReply(ctx, path, items);
    }
    if (rest.length === 2 && method === 'GET') {
      const sha = resolveRef(repo, decodeURIComponent(rest[1]!));
      if (sha === null) return { status: 404, body: err('Not Found') };
      const item = commitJson(ctx, repo, sha);
      if (item === null) return { status: 404, body: err('Not Found') };
      return { status: 200, body: item };
    }
    return { status: 404, body: err('Not Found') };
  }

  // git refs
  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (rest.length === 2 && method === 'GET') {
      const items = [...repo.refs.entries()].map(([ref, sha]) => ({
        ref,
        object: { sha, type: ref.startsWith('refs/tags/') && repo.objects.get(sha)?.type === 'tag' ? 'tag' : 'commit' },
        url: `${repoUrl(ctx, repo)}/git/refs/${encodeURIComponent(ref)}`,
      }));
      return { status: 200, body: items };
    }
    if (rest.length === 2 && method === 'POST') {
      const input = bodyRecord(ctx.body);
      const ref = typeof input.ref === 'string' ? input.ref : '';
      const sha = typeof input.sha === 'string' ? input.sha : '';
      if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/.test(sha) || !repo.objects.has(sha)) {
        return { status: 422, body: err('ref or sha is not valid') };
      }
      if (repo.refs.has(ref)) return { status: 422, body: err('Reference already exists') };
      repo.refs.set(ref, sha);
      return { status: 201, body: { ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } } };
    }
    if (rest.length >= 3 && method === 'GET') {
      const ref = rest.slice(2).map((s) => decodeURIComponent(s)).join('/');
      const sha = repo.refs.get(ref);
      if (sha === undefined) return { status: 404, body: err('Not Found') };
      return { status: 200, body: { ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } } };
    }
    if (rest.length >= 3 && method === 'PATCH') {
      const ref = rest.slice(2).map((s) => decodeURIComponent(s)).join('/');
      const sha = repo.refs.get(ref);
      if (sha === undefined) return { status: 404, body: err('Not Found') };
      const input = bodyRecord(ctx.body);
      const newSha = typeof input.sha === 'string' ? input.sha : '';
      if (!/^[0-9a-f]{40}$/.test(newSha) || !repo.objects.has(newSha)) {
        return { status: 422, body: err('sha is not valid') };
      }
      repo.refs.set(ref, newSha);
      return { status: 200, body: { ref, object: { sha: newSha, type: repo.objects.get(newSha)?.type ?? 'commit' } } };
    }
    if (rest.length >= 3 && method === 'DELETE') {
      const ref = rest.slice(2).map((s) => decodeURIComponent(s)).join('/');
      if (!repo.refs.has(ref)) return { status: 404, body: err('Not Found') };
      repo.refs.delete(ref);
      return { status: 204, empty: true };
    }
    return { status: 404, body: err('Not Found') };
  }

  // contents
  if (rest[0] === 'contents') {
    const filePath = rest.slice(1).map((s) => decodeURIComponent(s)).join('/');
    const refParam = ctx.query.get('ref') ?? repo.defaultBranch;
    const tip = resolveRef(repo, refParam);
    const treeOid = tip === null ? null : (() => {
      const object = repo.objects.get(tip);
      return object?.type === 'commit' ? parseCommit(object.data).tree : null;
    })();
    if (method === 'GET') {
      if (treeOid === null && tip === null) return { status: 404, body: err('Not Found') };
      if (filePath === '') {
        const entries = listTreeDir(repo, treeOid, '') ?? [];
        return {
          status: 200,
          body: entries.map((e) => ({
            type: e.mode === '40000' ? 'dir' : 'file',
            name: e.name,
            path: e.name,
            sha: e.oid,
            size: e.mode === '40000' ? 0 : (repo.objects.get(e.oid)?.data.length ?? 0),
            url: `${repoUrl(ctx, repo)}/contents/${encodeURIComponent(e.name)}`,
          })),
        };
      }
      const entry = treeOid === null ? null : treeLookup(repo, treeOid, filePath);
      if (entry === null) {
        // Maybe a directory.
        const dir = treeOid === null ? null : listTreeDir(repo, treeOid, filePath);
        if (dir === null) return { status: 404, body: err('Not Found') };
        return {
          status: 200,
          body: dir.map((e) => ({
            type: e.mode === '40000' ? 'dir' : 'file',
            name: e.name,
            path: `${filePath}/${e.name}`,
            sha: e.oid,
            size: e.mode === '40000' ? 0 : (repo.objects.get(e.oid)?.data.length ?? 0),
            url: `${repoUrl(ctx, repo)}/contents/${encodeURIComponent(filePath)}/${encodeURIComponent(e.name)}`,
          })),
        };
      }
      if (entry.mode === '40000') {
        const dir = listTreeDir(repo, treeOid, filePath) ?? [];
        return {
          status: 200,
          body: dir.map((e) => ({
            type: e.mode === '40000' ? 'dir' : 'file',
            name: e.name,
            path: `${filePath}/${e.name}`,
            sha: e.oid,
            size: e.mode === '40000' ? 0 : (repo.objects.get(e.oid)?.data.length ?? 0),
            url: `${repoUrl(ctx, repo)}/contents/${encodeURIComponent(filePath)}/${encodeURIComponent(e.name)}`,
          })),
        };
      }
      const blob = repo.objects.get(entry.oid);
      if (blob === undefined) return { status: 404, body: err('Not Found') };
      return {
        status: 200,
        body: {
          type: 'file',
          encoding: 'base64',
          name: filePath.split('/').pop() ?? filePath,
          path: filePath,
          sha: entry.oid,
          size: blob.data.length,
          content: blob.data.toString('base64'),
          url: `${repoUrl(ctx, repo)}/contents/${encodeURIComponent(filePath)}`,
        },
      };
    }
    if (method === 'PUT') {
      const input = bodyRecord(ctx.body);
      const message = typeof input.message === 'string' ? input.message : 'Update file';
      const contentB64 = typeof input.content === 'string' ? input.content : '';
      const branch = typeof input.branch === 'string' ? input.branch : repo.defaultBranch;
      let content: Buffer;
      try {
        content = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
      } catch {
        return { status: 422, body: err('content is not valid base64') };
      }
      const existing = treeOid === null ? null : treeLookup(repo, treeOid, filePath);
      const isCreate = existing === null;
      if (!isCreate) {
        const sha = typeof input.sha === 'string' ? input.sha : '';
        if (sha !== '' && sha !== existing!.oid) return { status: 409, body: err('sha does not match the current file') };
      }
      const { commitOid } = commitFileChange(repo, branch, filePath, content, message);
      const newEntry = (() => {
        const tipNow = repo.refs.get(`refs/heads/${branch}`);
        if (tipNow === undefined) return null;
        const object = repo.objects.get(tipNow);
        if (object?.type !== 'commit') return null;
        return treeLookup(repo, parseCommit(object.data).tree, filePath);
      })();
      if (newEntry === null) return { status: 500, body: err('could not read back the written file') };
      return {
        status: isCreate ? 201 : 200,
        body: {
          content: {
            type: 'file',
            encoding: 'base64',
            name: filePath.split('/').pop() ?? filePath,
            path: filePath,
            sha: newEntry.oid,
            size: content.length,
            content: contentB64,
          },
          commit: { sha: commitOid, message },
        },
      };
    }
    if (method === 'DELETE') {
      const input = bodyRecord(ctx.body);
      const message = typeof input.message === 'string' ? input.message : 'Delete file';
      const branch = typeof input.branch === 'string' ? input.branch : repo.defaultBranch;
      const existing = treeOid === null ? null : treeLookup(repo, treeOid, filePath);
      if (existing === null) return { status: 404, body: err('Not Found') };
      const sha = typeof input.sha === 'string' ? input.sha : '';
      if (sha !== '' && sha !== existing.oid) return { status: 409, body: err('sha does not match the current file') };
      const { commitOid, changed } = commitFileChange(repo, branch, filePath, null, message);
      if (!changed) return { status: 404, body: err('Not Found') };
      return { status: 200, body: { commit: { sha: commitOid, message } } };
    }
    return { status: 404, body: err('Not Found') };
  }

  // labels
  if (rest[0] === 'labels') {
    if (method === 'GET') {
      return {
        status: 200,
        body: repo.labels.map((l) => ({ id: l.id, name: l.name, color: l.color, description: l.description })),
      };
    }
    if (method === 'POST') {
      const input = bodyRecord(ctx.body);
      const name = typeof input.name === 'string' ? input.name : '';
      if (name === '') return { status: 422, body: err('name is required') };
      if (repo.labels.some((l) => l.name === name)) return { status: 422, body: err('label already exists') };
      const label = {
        id: ctx.store.nextId(),
        name,
        color: typeof input.color === 'string' ? input.color.replace(/^#/, '') : 'ededed',
        description: typeof input.description === 'string' ? input.description : '',
      };
      repo.labels.push(label);
      return { status: 201, body: { id: label.id, name: label.name, color: label.color, description: label.description } };
    }
    return { status: 404, body: err('Not Found') };
  }

  // issues
  if (rest[0] === 'issues') {
    if (rest.length === 1 && method === 'GET') {
      const state = (ctx.query.get('state') ?? 'open').toLowerCase();
      const sort = ctx.query.get('sort') ?? 'created';
      const direction = (ctx.query.get('direction') ?? 'desc').toLowerCase();
      let list = [...repo.issues];
      if (state !== 'all') list = list.filter((i) => i.state === state);
      list.sort((a, b) => {
        const key = sort === 'created' ? (x: Issue) => x.number : (x: Issue) => x.number;
        return direction === 'asc' ? key(a) - key(b) : key(b) - key(a);
      });
      return pagedReply(ctx, path, list.map((i) => fullIssueJson(ctx, repo, i)));
    }
    if (rest.length === 1 && method === 'POST') {
      const input = bodyRecord(ctx.body);
      const title = typeof input.title === 'string' ? input.title : '';
      if (title === '') return { status: 422, body: err('title is required') };
      const wantedLabels = Array.isArray(input.labels) ? (input.labels as unknown[]) : [];
      const labels: Issue['labels'] = [];
      for (const wanted of wantedLabels) {
        const name = typeof wanted === 'string' ? wanted : (wanted as Record<string, unknown>)?.name;
        if (typeof name !== 'string') continue;
        const found = repo.labels.find((l) => l.name === name);
        if (found === undefined) return { status: 422, body: err(`label ${name} does not exist`) };
        labels.push(found);
      }
      const issue: Issue = {
        id: ctx.store.nextId(),
        number: repo.nextIssue++,
        title,
        body: typeof input.body === 'string' ? input.body : '',
        state: 'open',
        labels,
        userLogin: ctx.store.viewerLogin ?? '',
        comments: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        closedAt: null,
      };
      repo.issues.push(issue);
      return { status: 201, body: fullIssueJson(ctx, repo, issue) };
    }
    if (rest.length >= 2) {
      const number = Number(rest[1]);
      const issue = repo.issues.find((i) => i.number === number);
      if (issue === undefined) return { status: 404, body: err('Not Found') };
      if (rest.length === 2 && method === 'GET') return { status: 200, body: fullIssueJson(ctx, repo, issue) };
      if (rest.length === 2 && method === 'PATCH') {
        const input = bodyRecord(ctx.body);
        if (typeof input.title === 'string') issue.title = input.title;
        if (typeof input.body === 'string') issue.body = input.body;
        if (input.state === 'closed' || input.state === 'open') {
          issue.state = input.state;
          issue.closedAt = input.state === 'closed' ? new Date().toISOString() : null;
        }
        issue.updatedAt = new Date().toISOString();
        return { status: 200, body: fullIssueJson(ctx, repo, issue) };
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (method === 'GET') {
          return {
            status: 200,
            body: issue.comments.map((c) => ({
              id: c.id,
              body: c.body,
              user: { login: c.userLogin, id: 1, type: 'User' },
              created_at: c.createdAt,
              updated_at: c.updatedAt,
              url: `${repoUrl(ctx, repo)}/issues/${issue.number}/comments/${c.id}`,
            })),
          };
        }
        if (method === 'POST') {
          const input = bodyRecord(ctx.body);
          const commentBody = typeof input.body === 'string' ? input.body : '';
          const comment = {
            id: repo.nextCommentId++,
            body: commentBody,
            userLogin: ctx.store.viewerLogin ?? '',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
          issue.comments.push(comment);
          return {
            status: 201,
            body: {
              id: comment.id,
              body: comment.body,
              user: { login: comment.userLogin, id: 1, type: 'User' },
              created_at: comment.createdAt,
              updated_at: comment.updatedAt,
              url: `${repoUrl(ctx, repo)}/issues/${issue.number}/comments/${comment.id}`,
            },
          };
        }
      }
    }
    return { status: 404, body: err('Not Found') };
  }

  // pulls
  if (rest[0] === 'pulls') {
    if (rest.length === 1 && method === 'GET') {
      const state = (ctx.query.get('state') ?? 'open').toLowerCase();
      let list = [...repo.pulls];
      if (state === 'open') list = list.filter((p) => p.state === 'open');
      else if (state === 'closed') list = list.filter((p) => p.state === 'closed');
      list.sort((a, b) => b.number - a.number);
      return pagedReply(ctx, path, list.map((p) => fullPullJson(ctx, repo, p)));
    }
    if (rest.length === 1 && method === 'POST') {
      const input = bodyRecord(ctx.body);
      const title = typeof input.title === 'string' ? input.title : '';
      const head = typeof input.head === 'string' ? input.head : '';
      const base = typeof input.base === 'string' ? input.base : repo.defaultBranch;
      if (title === '' || head === '') return { status: 422, body: err('title and head are required') };
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (headSha === undefined || baseSha === undefined) {
        return { status: 422, body: err('head or base branch does not exist') };
      }
      const duplicate = repo.pulls.find((p) => p.state === 'open' && p.headRef === head && p.baseRef === base);
      if (duplicate !== undefined) return { status: 422, body: err('a pull request already exists for this head branch') };
      const pull: PullRequest = {
        id: ctx.store.nextId(),
        number: repo.nextPull++,
        title,
        body: typeof input.body === 'string' ? input.body : '',
        state: 'open',
        headRef: head,
        headSha,
        baseRef: base,
        baseSha,
        userLogin: ctx.store.viewerLogin ?? '',
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      repo.pulls.push(pull);
      return { status: 201, body: fullPullJson(ctx, repo, pull) };
    }
    if (rest.length >= 2) {
      const number = Number(rest[1]);
      const pull = repo.pulls.find((p) => p.number === number);
      if (pull === undefined) return { status: 404, body: err('Not Found') };
      if (rest.length === 2 && method === 'GET') return { status: 200, body: fullPullJson(ctx, repo, pull) };
      if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
        const baseCommit = repo.objects.get(pull.baseSha);
        const headCommit = repo.objects.get(pull.headSha);
        const baseTree = baseCommit?.type === 'commit' ? parseCommit(baseCommit.data).tree : null;
        const headTree = headCommit?.type === 'commit' ? parseCommit(headCommit.data).tree : null;
        return { status: 200, body: diffTrees(repo, baseTree, headTree) };
      }
      if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
        if (pull.state !== 'open' || pull.merged) return { status: 405, body: err('pull request is already closed') };
        if (pull.headSha === '' || pull.baseSha === '') return { status: 405, body: err('pull request has no head or base') };
        // Merge against the CURRENT base tip: the recorded baseSha is stale once the
        // base branch advances (e.g. after another PR merged into it).
        const currentBase = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
        if (isAncestor(repo, pull.headSha, currentBase) && pull.headSha !== currentBase) {
          return { status: 405, body: err('pull request is already merged') };
        }
        if (mergeConflicts(repo, currentBase, pull.headSha)) {
          return { status: 405, body: err('merge conflict') };
        }
        pull.baseSha = currentBase;
        const merged = mergePullRequestInternal(repo, pull);
        if (merged === null) return { status: 405, body: err('merge failed') };
        return {
          status: 200,
          body: { sha: merged.mergeCommitSha, merged: true, message: `Merged pull request #${pull.number}` },
        };
      }
    }
    return { status: 404, body: err('Not Found') };
  }

  return { status: 404, body: err('Not Found') };
}
