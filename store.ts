// store.ts — the forge's in-memory state: repositories, git objects, refs, issues,
// pull requests, labels and comments. One viewer per trial; the viewer login is learned
// from the first owner-bearing URL (the token does not encode it).

import {
  ZERO_OID,
  buildCommit,
  buildTree,
  collectAncestors,
  hashObject,
  isObjectId,
  parseCommit,
  parseTree,
  type GitObject,
  type GitObjectType,
  type TreeEntry,
} from './git.ts';

export const FORGE_AUTHOR = 'Forge <forge@make.fun>';

export function nowIso(): string {
  return new Date().toISOString();
}

export function stampNow(): string {
  const sec = Math.floor(Date.now() / 1000);
  return `${sec} +0000`;
}

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface IssueComment {
  id: number;
  body: string;
  userLogin: string;
  createdAt: string;
  updatedAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  userLogin: string;
  comments: IssueComment[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  userLogin: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Repo {
  id: number;
  name: string;
  owner: string | null; // null until the viewer login is learned
  description: string;
  private: boolean;
  defaultBranch: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Label[];
  issues: Issue[];
  pulls: PullRequest[];
  nextIssue: number;
  nextPull: number;
  nextCommentId: number;
  createdAt: string;
  updatedAt: string;
}

let nextRepoId = 1;
let nextGlobalId = 1;

export class Store {
  viewerLogin: string | null = null;
  private bound = new Map<string, Repo>(); // "owner/name" -> repo
  private unbound = new Map<string, Repo>(); // name -> repo (created before the viewer was learned)
  private byId = new Map<number, Repo>();

  repoById(id: number): Repo | null {
    return this.byId.get(id) ?? null;
  }

  createRepo(name: string, description: string, isPrivate: boolean): { repo: Repo | null; duplicate: boolean } {
    if (this.boundHasName(name) || this.unbound.has(name)) return { repo: null, duplicate: true };
    const repo: Repo = {
      id: nextRepoId++,
      name,
      owner: this.viewerLogin,
      description,
      private: isPrivate,
      defaultBranch: 'main',
      objects: new Map(),
      refs: new Map(),
      labels: [],
      issues: [],
      pulls: [],
      nextIssue: 1,
      nextPull: 1,
      nextCommentId: 1,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    if (repo.owner !== null) this.bound.set(`${repo.owner}/${name}`, repo);
    else this.unbound.set(name, repo);
    this.byId.set(repo.id, repo);
    return { repo, duplicate: false };
  }

  private boundHasName(name: string): boolean {
    for (const repo of this.bound.values()) if (repo.name === name) return true;
    return false;
  }

  /** Resolve a repo by owner/name, binding an unbound repo to the owner when legal. */
  resolveRepo(owner: string, name: string): Repo | null {
    const key = `${owner}/${name}`;
    const direct = this.bound.get(key);
    if (direct !== undefined) return direct;
    const pending = this.unbound.get(name);
    if (pending === undefined) return null;
    // A repo created before the viewer was known belongs to whoever asks for it first,
    // as long as that owner is the (single) viewer of this trial.
    if (this.viewerLogin === null) {
      this.viewerLogin = owner;
      pending.owner = owner;
      this.unbound.delete(name);
      this.bound.set(key, pending);
      return pending;
    }
    if (this.viewerLogin === owner) {
      pending.owner = owner;
      this.unbound.delete(name);
      this.bound.set(key, pending);
      return pending;
    }
    return null; // foreign owner
  }

  /** All repos the viewer owns (bound + still-unbound), newest last. */
  listViewerRepos(): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.bound.values()) {
      if (repo.owner === this.viewerLogin || this.viewerLogin === null) out.push(repo);
    }
    for (const repo of this.unbound.values()) out.push(repo);
    out.sort((a, b) => a.id - b.id);
    return out;
  }

  deleteRepo(repo: Repo): void {
    if (repo.owner !== null) this.bound.delete(`${repo.owner}/${repo.name}`);
    this.unbound.delete(repo.name);
  }

  nextId(): number {
    return nextGlobalId++;
  }
}

// ---------------------------------------------------------------- git objects

export function getObject(repo: Repo, oid: string): GitObject | undefined {
  return repo.objects.get(oid);
}

export function putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

export function refTarget(repo: Repo, ref: string): string | null {
  return repo.refs.get(ref) ?? null;
}

export function defaultBranchRef(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

/** Is `ancestor` reachable from `commit` (or equal)? Early-exit walk: for the common
 * fast-forward case the ancestor is the immediate parent, so this is O(1) instead of
 * walking the whole history (which made sequential pushes quadratic). */
export function isAncestor(repo: Repo, ancestor: string, commit: string): boolean {
  if (ancestor === commit) return true;
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const queue = [commit];
  const seen = new Set<string>([commit]);
  for (let head = 0; head < queue.length; head += 1) {
    const oid = queue[head]!;
    const object = lookup(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (parent === ancestor) return true;
      if (!seen.has(parent)) {
        seen.add(parent);
        queue.push(parent);
      }
    }
  }
  return false;
}

/** First common ancestor of two commits (merge-base), or null. */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const aAncestors = collectAncestors([a], lookup);
  const queue = [b];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (aAncestors.has(oid)) return oid;
    const object = lookup(oid);
    if (object?.type === 'commit') {
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
  }
  return null;
}

/** Commits from `tip` back, newest first (BFS by generation, parents after children). */
export function listCommits(repo: Repo, tip: string, limit = 100): string[] {
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const out: string[] = [];
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length > 0 && out.length < limit) {
    const oid = queue.shift()!;
    if (seen.has(oid) || !isObjectId(oid)) continue;
    seen.add(oid);
    const object = lookup(oid);
    if (object?.type !== 'commit') continue;
    out.push(oid);
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return out;
}

// ---------------------------------------------------------------- trees

/** Read a path out of a tree (nested). Returns the leaf entry or null. */
export function treeLookup(repo: Repo, rootTreeOid: string, path: string): TreeEntry | null {
  const segments = path.split('/').filter((s) => s !== '');
  let treeOid = rootTreeOid;
  for (let i = 0; i < segments.length; i += 1) {
    const object = repo.objects.get(treeOid);
    if (object?.type !== 'tree') return null;
    const entry = parseTree(object.data).find((e) => e.name === segments[i]);
    if (entry === undefined) return null;
    if (i === segments.length - 1) return entry;
    if (entry.mode !== '40000') return null;
    treeOid = entry.oid;
  }
  return null;
}

/** Set (or replace) `path` in the tree, creating intermediate directories. */
export function treeSetPath(repo: Repo, rootTreeOid: string | null, path: string, blobOid: string): string {
  const segments = path.split('/').filter((s) => s !== '');
  const set = (treeOid: string | null, depth: number): string => {
    const entries: TreeEntry[] =
      treeOid === null ? [] : [...parseTree(repo.objects.get(treeOid)?.data ?? Buffer.alloc(0))];
    const name = segments[depth]!;
    const existing = entries.findIndex((e) => e.name === name);
    if (depth === segments.length - 1) {
      const entry: TreeEntry = { mode: '100644', name, oid: blobOid };
      if (existing >= 0) entries[existing] = entry;
      else entries.push(entry);
    } else {
      const childOid = existing >= 0 && entries[existing]!.mode === '40000' ? entries[existing]!.oid : null;
      const newChild = set(childOid, depth + 1);
      const entry: TreeEntry = { mode: '40000', name, oid: newChild };
      if (existing >= 0) entries[existing] = entry;
      else entries.push(entry);
    }
    return putObject(repo, 'tree', buildTree(entries));
  };
  return set(rootTreeOid, 0);
}

/** Delete `path` from the tree (pruning directories left empty). Returns null when empty. */
export function treeDeletePath(repo: Repo, rootTreeOid: string | null, path: string): string | null {
  const segments = path.split('/').filter((s) => s !== '');
  const del = (treeOid: string | null, depth: number): string | null => {
    if (treeOid === null) return null;
    const object = repo.objects.get(treeOid);
    if (object?.type !== 'tree') return treeOid;
    let entries = parseTree(object.data);
    const name = segments[depth]!;
    const index = entries.findIndex((e) => e.name === name);
    if (index < 0) return treeOid;
    if (depth === segments.length - 1) {
      entries = entries.filter((_, i) => i !== index);
    } else {
      const child = entries[index]!;
      if (child.mode !== '40000') return treeOid;
      const newChild = del(child.oid, depth + 1);
      if (newChild === null) entries = entries.filter((_, i) => i !== index);
      else entries[index] = { ...child, oid: newChild };
    }
    if (entries.length === 0) return null;
    return putObject(repo, 'tree', buildTree(entries));
  };
  return del(rootTreeOid, 0);
}

/** Flat map of every file path in a tree to its blob oid. */
export function flattenTree(repo: Repo, rootTreeOid: string | null, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  if (rootTreeOid === null) return out;
  const object = repo.objects.get(rootTreeOid);
  if (object?.type !== 'tree') return out;
  for (const entry of parseTree(object.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') {
      for (const [p, oid] of flattenTree(repo, entry.oid, path)) out.set(p, oid);
    } else {
      out.set(path, entry.oid);
    }
  }
  return out;
}

/** List one directory level of a tree. */
export function listTreeDir(repo: Repo, rootTreeOid: string | null, dir: string): TreeEntry[] | null {
  let treeOid = rootTreeOid;
  if (dir !== '') {
    const entry = treeLookup(repo, rootTreeOid ?? '', dir);
    if (entry === null || entry.mode !== '40000') return null;
    treeOid = entry.oid;
  }
  if (treeOid === null) return [];
  const object = repo.objects.get(treeOid);
  if (object?.type !== 'tree') return null;
  return parseTree(object.data);
}

// ---------------------------------------------------------------- commits via the contents API

export function makeCommit(
  repo: Repo,
  treeOid: string,
  parents: readonly string[],
  message: string,
): string {
  const stamp = stampNow();
  const author = `${FORGE_AUTHOR} ${stamp}`;
  const data = buildCommit({ tree: treeOid, parents, author, committer: author, message: message.endsWith('\n') ? message : `${message}\n` });
  return putObject(repo, 'commit', data);
}

/** Create a contents commit on `branch` (creating the branch from the default tip when needed). */
export function commitFileChange(
  repo: Repo,
  branch: string,
  path: string,
  content: Buffer | null, // null = delete
  message: string,
): { commitOid: string; changed: boolean } {
  const ref = `refs/heads/${branch}`;
  const tip = repo.refs.get(ref);
  let parentTree: string | null = null;
  const parents: string[] = [];
  if (tip !== undefined) {
    const commit = repo.objects.get(tip);
    if (commit?.type === 'commit') {
      parentTree = parseCommit(commit.data).tree;
      parents.push(tip);
    }
  } else if (branch !== repo.defaultBranch) {
    // A new branch starts from the default branch tip.
    const baseTip = repo.refs.get(defaultBranchRef(repo));
    if (baseTip !== undefined) {
      const commit = repo.objects.get(baseTip);
      if (commit?.type === 'commit') {
        parentTree = parseCommit(commit.data).tree;
        parents.push(baseTip);
      }
    }
  }
  let newTree: string | null;
  if (content === null) {
    newTree = treeDeletePath(repo, parentTree, path);
    if (newTree === parentTree) return { commitOid: tip ?? '', changed: false };
  } else {
    const blobOid = putObject(repo, 'blob', content);
    newTree = treeSetPath(repo, parentTree, path, blobOid);
  }
  const treeOid = newTree ?? putObject(repo, 'tree', buildTree([]));
  const commitOid = makeCommit(repo, treeOid, parents, message);
  repo.refs.set(ref, commitOid);
  return { commitOid, changed: true };
}

// ---------------------------------------------------------------- diffs

export interface FileChange {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
}

function countLines(data: Buffer): number {
  if (data.length === 0) return 0;
  const text = data.toString('utf8');
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

function lineDiff(oldData: Buffer, newData: Buffer): { additions: number; deletions: number } {
  const oldLines = new Set(oldData.toString('utf8').split('\n'));
  const newLines = new Set(newData.toString('utf8').split('\n'));
  let additions = 0;
  for (const line of newLines) if (!oldLines.has(line)) additions += 1;
  let deletions = 0;
  for (const line of oldLines) if (!newLines.has(line)) deletions += 1;
  return { additions, deletions };
}

export function diffTrees(repo: Repo, baseTreeOid: string | null, headTreeOid: string | null): FileChange[] {
  const base = flattenTree(repo, baseTreeOid);
  const head = flattenTree(repo, headTreeOid);
  const out: FileChange[] = [];
  const paths = new Set([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b !== undefined && h === undefined) {
      const deletions = countLines(repo.objects.get(b)?.data ?? Buffer.alloc(0));
      out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else if (b === undefined && h !== undefined) {
      const additions = countLines(repo.objects.get(h)?.data ?? Buffer.alloc(0));
      out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (b !== undefined && h !== undefined && b !== h) {
      const { additions, deletions } = lineDiff(
        repo.objects.get(b)?.data ?? Buffer.alloc(0),
        repo.objects.get(h)?.data ?? Buffer.alloc(0),
      );
      out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  return out;
}

/** Would merging `headTip` into `baseTip` conflict? (same file changed differently on both sides) */
export function mergeConflicts(repo: Repo, baseTip: string, headTip: string): boolean {
  const base = mergeBase(repo, baseTip, headTip);
  if (base === null) return false;
  const baseCommit = repo.objects.get(base);
  if (baseCommit?.type !== 'commit') return false;
  const ancestorTree = parseCommit(baseCommit.data).tree;
  const baseFiles = flattenTree(repo, ancestorTree);
  const headCommit = repo.objects.get(headTip);
  const baseTipCommit = repo.objects.get(baseTip);
  if (headCommit?.type !== 'commit' || baseTipCommit?.type !== 'commit') return false;
  const headFiles = flattenTree(repo, parseCommit(headCommit.data).tree);
  const baseTipFiles = flattenTree(repo, parseCommit(baseTipCommit.data).tree);
  for (const [path, ancestorOid] of baseFiles) {
    const h = headFiles.get(path);
    const b = baseTipFiles.get(path);
    if (h !== undefined && b !== undefined && h !== ancestorOid && b !== ancestorOid && h !== b) return true;
    if (h === undefined && b !== undefined && b !== ancestorOid) return true; // deleted on head, changed on base
    if (b === undefined && h !== undefined && h !== ancestorOid) return true; // deleted on base, changed on head
  }
  // Files added on both sides with different content.
  for (const [path, h] of headFiles) {
    if (!baseFiles.has(path)) {
      const b = baseTipFiles.get(path);
      if (b !== undefined && b !== h) return true;
    }
  }
  return false;
}
