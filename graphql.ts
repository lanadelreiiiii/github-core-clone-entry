// graphql.ts — a small GraphQL executor for the v4 documents the suite sends
// (gh / github-mcp-server shapes). No schema library: a hand-rolled parser for the
// document subset used (fields, arguments, variables, aliases, inline + named
// fragments, introspection __type) and resolvers over the store.

import { buildCommit, hashObject, parseCommit } from './git.ts';
import { diffTrees, mergeConflicts, type Issue, type PullRequest, type Repo, type Store } from './store.ts';

// ---------------------------------------------------------------- global ids

function b64urlEncode(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

function b64urlDecode(text: string): string | null {
  try {
    return Buffer.from(text, 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

export function repoGlobalId(repo: Repo): string {
  return b64urlEncode(`g:repo:${repo.id}`);
}

export function issueGlobalId(repo: Repo, issue: Issue): string {
  return b64urlEncode(`g:issue:${repo.id}:${issue.number}`);
}

export function pullGlobalId(repo: Repo, pull: PullRequest): string {
  return b64urlEncode(`g:pr:${repo.id}:${pull.number}`);
}

export function userGlobalId(login: string): string {
  return b64urlEncode(`g:user:${login}`);
}

export function commentGlobalId(repo: Repo, issue: Issue, commentId: number): string {
  return b64urlEncode(`g:comment:${repo.id}:${issue.number}:${commentId}`);
}

interface DecodedId {
  kind: string;
  parts: string[];
}

export function decodeGlobalId(id: string): DecodedId | null {
  const text = b64urlDecode(id);
  if (text === null || !text.startsWith('g:')) return null;
  const parts = text.slice(2).split(':');
  const kind = parts.shift();
  if (kind === undefined) return null;
  return { kind, parts };
}

// ---------------------------------------------------------------- parser

type ValueNode =
  | { kind: 'Variable'; name: string }
  | { kind: 'String'; value: string }
  | { kind: 'Int'; value: number }
  | { kind: 'Float'; value: number }
  | { kind: 'Boolean'; value: boolean }
  | { kind: 'Enum'; value: string }
  | { kind: 'Null' }
  | { kind: 'List'; values: ValueNode[] }
  | { kind: 'Object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  kind: 'Field';
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selection: SelectionNode[] | null;
}

interface FragmentSpreadNode {
  kind: 'FragmentSpread';
  name: string;
}

interface InlineFragmentNode {
  kind: 'InlineFragment';
  typeCondition: string | null;
  selection: SelectionNode[];
}

type SelectionNode = FieldNode | FragmentSpreadNode | InlineFragmentNode;

interface OperationNode {
  kind: 'Operation';
  operation: 'query' | 'mutation';
  name: string | null;
  variables: Array<{ name: string; defaultValue: ValueNode | null }>;
  selection: SelectionNode[];
}

interface FragmentNode {
  kind: 'Fragment';
  name: string;
  typeCondition: string;
  selection: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, FragmentNode>;
}

class Lexer {
  private pos = 0;
  private readonly src: string;
  constructor(src: string) {
    this.src = src;
  }

  private skipIgnored(): void {
    for (;;) {
      while (this.pos < this.src.length && /[\s,]/.test(this.src[this.pos]!)) this.pos += 1;
      if (this.src[this.pos] === '#') {
        while (this.pos < this.src.length && this.src[this.pos] !== '\n') this.pos += 1;
        continue;
      }
      break;
    }
  }

  peek(): string {
    this.skipIgnored();
    return this.src[this.pos] ?? '';
  }

  next(): string {
    this.skipIgnored();
    const ch = this.src[this.pos] ?? '';
    if (ch === '') return '';
    if (ch === '.' && this.src.slice(this.pos, this.pos + 3) === '...') {
      this.pos += 3;
      return '...';
    }
    if ('!():=@[]{ }|'.includes(ch) || ch === '&') {
      this.pos += 1;
      return ch;
    }
    if (ch === '"') {
      // String (supports \" \\ \n escapes and block strings """...""").
      if (this.src.slice(this.pos, this.pos + 3) === '"""') {
        const end = this.src.indexOf('"""', this.pos + 3);
        const raw = end < 0 ? this.src.slice(this.pos + 3) : this.src.slice(this.pos + 3, end);
        this.pos = end < 0 ? this.src.length : end + 3;
        return JSON.stringify(raw);
      }
      let out = '';
      this.pos += 1;
      while (this.pos < this.src.length && this.src[this.pos] !== '"') {
        const c = this.src[this.pos]!;
        if (c === '\\' && this.pos + 1 < this.src.length) {
          const esc = this.src[this.pos + 1]!;
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else out += esc;
          this.pos += 2;
        } else {
          out += c;
          this.pos += 1;
        }
      }
      this.pos += 1;
      return JSON.stringify(out);
    }
    if (ch === '$') {
      let end = this.pos + 1;
      while (end < this.src.length && /[_A-Za-z0-9]/.test(this.src[end]!)) end += 1;
      const token = this.src.slice(this.pos, end);
      this.pos = end;
      return token;
    }
    // Name / number
    let end = this.pos;
    while (end < this.src.length && /[_A-Za-z0-9.\-+]/.test(this.src[end]!) && !/[\s,(){}[\]:!@$="]/.test(this.src[end]!)) end += 1;
    if (end === this.pos) {
      this.pos += 1;
      return ch;
    }
    const token = this.src.slice(this.pos, end);
    this.pos = end;
    return token;
  }
}

function parseValue(lexer: Lexer): ValueNode {
  const token = lexer.next();
  if (token.startsWith('$')) return { kind: 'Variable', name: token.slice(1) };
  if (token.startsWith('"')) return { kind: 'String', value: JSON.parse(token) as string };
  if (token === '[') {
    const values: ValueNode[] = [];
    while (lexer.peek() !== ']' && lexer.peek() !== '') values.push(parseValue(lexer));
    lexer.next(); // ]
    return { kind: 'List', values };
  }
  if (token === '{') {
    const fields: Array<{ name: string; value: ValueNode }> = [];
    while (lexer.peek() !== '}' && lexer.peek() !== '') {
      const name = lexer.next();
      if (lexer.next() !== ':') throw new Error('expected : in object value');
      fields.push({ name, value: parseValue(lexer) });
    }
    lexer.next(); // }
    return { kind: 'Object', fields };
  }
  if (token === 'true') return { kind: 'Boolean', value: true };
  if (token === 'false') return { kind: 'Boolean', value: false };
  if (token === 'null') return { kind: 'Null' };
  if (/^-?\d+$/.test(token)) return { kind: 'Int', value: Number(token) };
  if (/^-?\d*\.\d+([eE][+-]?\d+)?$/.test(token)) return { kind: 'Float', value: Number(token) };
  return { kind: 'Enum', value: token };
}

function parseSelectionSet(lexer: Lexer): SelectionNode[] {
  if (lexer.next() !== '{') throw new Error('expected { for selection set');
  const selections: SelectionNode[] = [];
  while (lexer.peek() !== '}' && lexer.peek() !== '') {
    const token = lexer.next();
    if (token === '...') {
      const next = lexer.next();
      if (next === 'on') {
        const typeCondition = lexer.next();
        selections.push({ kind: 'InlineFragment', typeCondition, selection: parseSelectionSet(lexer) });
      } else {
        selections.push({ kind: 'FragmentSpread', name: next });
      }
      continue;
    }
    // Field: [alias:] name [(args)] [selection]
    let alias: string | null = null;
    let name = token;
    if (lexer.peek() === ':') {
      lexer.next();
      alias = name;
      name = lexer.next();
    }
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (lexer.peek() === '(') {
      lexer.next();
      while (lexer.peek() !== ')' && lexer.peek() !== '') {
        const argName = lexer.next();
        if (lexer.next() !== ':') throw new Error('expected : in argument');
        args.push({ name: argName, value: parseValue(lexer) });
      }
      lexer.next(); // )
    }
    let selection: SelectionNode[] | null = null;
    if (lexer.peek() === '{') selection = parseSelectionSet(lexer);
    selections.push({ kind: 'Field', alias, name, args, selection });
  }
  lexer.next(); // }
  return selections;
}

function parseDocument(src: string): DocumentNode {
  const lexer = new Lexer(src);
  const operations: OperationNode[] = [];
  const fragments = new Map<string, FragmentNode>();
  while (lexer.peek() !== '') {
    const token = lexer.next();
    if (token === 'query' || token === 'mutation') {
      let name: string | null = null;
      const peek = lexer.peek();
      if (peek !== '' && peek !== '(' && peek !== '{') name = lexer.next();
      const variables: Array<{ name: string; defaultValue: ValueNode | null }> = [];
      if (lexer.peek() === '(') {
        lexer.next(); // (
        let closed = false;
        while (!closed) {
          const head = lexer.peek();
          if (head === ')') {
            lexer.next();
            break;
          }
          if (head === '') break;
          const varToken = lexer.next();
          if (!varToken.startsWith('$')) throw new Error('expected variable');
          // Skip the type: names, [ ... ] groups and trailing ! marks.
          let depth = 0;
          let defaultValue: ValueNode | null = null;
          for (;;) {
            const t = lexer.next();
            if (t === '') break;
            if (t === '[') depth += 1;
            else if (t === ']') depth -= 1;
            else if (t === '=' && depth === 0) {
              defaultValue = parseValue(lexer);
              break;
            } else if (t === ')' && depth === 0) {
              closed = true;
              break;
            } else if (t === ',' && depth === 0) {
              break;
            }
          }
          variables.push({ name: varToken.slice(1), defaultValue });
        }
      }
      operations.push({ kind: 'Operation', operation: token, name, variables, selection: parseSelectionSet(lexer) });
    } else if (token === 'fragment') {
      const name = lexer.next();
      if (lexer.next() !== 'on') throw new Error('expected on in fragment');
      const typeCondition = lexer.next();
      fragments.set(name, { kind: 'Fragment', name, typeCondition, selection: parseSelectionSet(lexer) });
    } else if (token === '{') {
      // Anonymous query: re-parse as a selection set. The lexer already consumed '{';
      // emulate by building selections directly is complex — instead treat as error-free
      // by rewinding: not supported; the suite always names its operations.
      throw new Error('anonymous shorthand queries are not supported');
    } else {
      throw new Error(`unexpected token ${JSON.stringify(token)} in document`);
    }
  }
  return { operations, fragments };
}

// ---------------------------------------------------------------- execution

export interface GraphQLError {
  message: string;
  path?: Array<string | number>;
}

interface ExecContext {
  store: Store;
  variables: Record<string, unknown>;
  errors: GraphQLError[];
  fragments: Map<string, FragmentNode>;
}

function valueFromNode(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'Variable':
      return variables[node.name];
    case 'String':
    case 'Int':
    case 'Float':
    case 'Boolean':
    case 'Enum':
      return node.value;
    case 'Null':
      return null;
    case 'List':
      return node.values.map((v) => valueFromNode(v, variables));
    case 'Object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = valueFromNode(field.value, variables);
      return out;
    }
  }
}

function argsOf(field: FieldNode, ctx: ExecContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = valueFromNode(arg.value, ctx.variables);
  return out;
}

/** The fields a type exposes (for __type introspection). */
const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'url', 'author', 'createdAt', 'updatedAt', 'labels', 'comments'],
  PullRequest: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRefOid', 'files', 'url', 'author', 'createdAt', 'updatedAt'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'description', 'isPrivate', 'url', 'issue', 'issues', 'pullRequest', 'pullRequests', 'createdAt', 'updatedAt'],
  User: ['id', 'databaseId', 'login', 'name', 'url', 'avatarUrl'],
  SearchType: [],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'MARKETPLACE_LISTING'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
};

interface RepoValue {
  __typename: 'Repository';
  repo: Repo;
}
interface IssueValue {
  __typename: 'Issue';
  repo: Repo;
  issue: Issue;
}
interface PullValue {
  __typename: 'PullRequest';
  repo: Repo;
  pull: PullRequest;
}
interface UserValue {
  __typename: 'User';
  login: string;
}
interface RefValue {
  __typename: 'Ref';
  name: string;
  oid: string | null;
}
type Value = RepoValue | IssueValue | PullValue | UserValue | RefValue | Record<string, unknown> | null;

function typenameOf(value: Value): string | null {
  if (value === null || typeof value !== 'object') return null;
  if ('__typename' in value && typeof value.__typename === 'string') return value.__typename;
  return null;
}

function cursorFor(number: number): string {
  return b64urlEncode(`c:${number}`);
}

function numberFromCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string') return null;
  const text = b64urlDecode(cursor);
  if (text === null || !text.startsWith('c:')) return null;
  const n = Number(text.slice(2));
  return Number.isInteger(n) ? n : null;
}

function paginateIssues(
  repo: Repo,
  args: Record<string, unknown>,
): { edges: Array<{ node: IssueValue; cursor: string }>; pageInfo: Record<string, unknown>; totalCount: number } {
  const first = typeof args.first === 'number' ? args.first : 100;
  const states = Array.isArray(args.states) ? (args.states as string[]) : null;
  const orderBy = (args.orderBy as Record<string, unknown> | undefined) ?? {};
  const direction = orderBy.direction === 'ASC' ? 'ASC' : 'DESC';
  let list = [...repo.issues];
  if (states !== null) {
    const wanted = new Set(states.map((s) => String(s).toLowerCase()));
    list = list.filter((issue) => wanted.has(issue.state));
  }
  list.sort((a, b) => (direction === 'DESC' ? b.number - a.number : a.number - b.number));
  const after = numberFromCursor(args.after);
  if (after !== null) {
    const index = list.findIndex((issue) => issue.number === after);
    if (index >= 0) list = list.slice(index + 1);
  }
  const page = list.slice(0, Math.max(0, first));
  const edges = page.map((issue) => ({
    node: { __typename: 'Issue', repo, issue } as IssueValue,
    cursor: cursorFor(issue.number),
  }));
  return {
    edges,
    pageInfo: {
      hasNextPage: list.length > page.length,
      hasPreviousPage: after !== null,
      startCursor: edges.length > 0 ? edges[0]!.cursor : null,
      endCursor: edges.length > 0 ? edges[edges.length - 1]!.cursor : null,
    },
    totalCount: repo.issues.length,
  };
}

function paginatePulls(
  repo: Repo,
  args: Record<string, unknown>,
): { edges: Array<{ node: PullValue; cursor: string }>; pageInfo: Record<string, unknown>; totalCount: number } {
  const first = typeof args.first === 'number' ? args.first : 100;
  const states = Array.isArray(args.states) ? (args.states as string[]) : null;
  let list = [...repo.pulls];
  if (states !== null) {
    const wanted = new Set(states.map((s) => String(s).toLowerCase()));
    list = list.filter((pull) => {
      const state = pull.merged ? 'merged' : pull.state;
      return wanted.has(state);
    });
  }
  list.sort((a, b) => b.number - a.number);
  const after = numberFromCursor(args.after);
  if (after !== null) {
    const index = list.findIndex((pull) => pull.number === after);
    if (index >= 0) list = list.slice(index + 1);
  }
  const page = list.slice(0, Math.max(0, first));
  const edges = page.map((pull) => ({
    node: { __typename: 'PullRequest', repo, pull } as PullValue,
    cursor: cursorFor(pull.number),
  }));
  return {
    edges,
    pageInfo: {
      hasNextPage: list.length > page.length,
      hasPreviousPage: after !== null,
      startCursor: edges.length > 0 ? edges[0]!.cursor : null,
      endCursor: edges.length > 0 ? edges[edges.length - 1]!.cursor : null,
    },
    totalCount: repo.pulls.length,
  };
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: PullRequest): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullMergeable(repo: Repo, pull: PullRequest): string {
  if (pull.state !== 'open') return 'UNKNOWN';
  const currentBase = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  return mergeConflicts(repo, currentBase, pull.headSha) ? 'CONFLICTING' : 'MERGEABLE';
}

function resolveField(
  ctx: ExecContext,
  typeName: string,
  value: Value,
  field: FieldNode,
): unknown {
  const args = argsOf(field, ctx);
  // Introspection entry points on Query.
  if (field.name === '__typename') return typeName;
  if (typeName === 'Query' && field.name === '__type') {
    const name = args.name as string | undefined;
    if (typeof name !== 'string') return null;
    if (TYPE_FIELDS[name] !== undefined || ENUM_VALUES[name] !== undefined) {
      return { __typename: '__Type', name, kind: ENUM_VALUES[name] !== undefined ? 'ENUM' : 'OBJECT' };
    }
    return null;
  }
  if (typeName === 'Query' && field.name === '__schema') {
    return { __typename: '__Schema', types: [] };
  }
  if (typeName === '__Type') {
    const typeValue = value as unknown as { name: string; kind: string };
    if (field.name === 'name') return typeValue.name;
    if (field.name === 'kind') return typeValue.kind;
    if (field.name === 'description') return null;
    if (field.name === 'fields') {
      const names = TYPE_FIELDS[typeValue.name] ?? [];
      return names.map((n) => ({ __typename: '__Field', name: n }));
    }
    if (field.name === 'enumValues') {
      const names = ENUM_VALUES[typeValue.name] ?? [];
      return names.map((n) => ({ __typename: '__EnumValue', name: n }));
    }
    return null;
  }
  if (typeName === '__Field') {
    const f = value as unknown as { name: string };
    if (field.name === 'name') return f.name;
    if (field.name === 'description') return null;
    if (field.name === 'args') return [];
    if (field.name === 'type') return null;
    return null;
  }
  if (typeName === '__EnumValue') {
    const f = value as unknown as { name: string };
    if (field.name === 'name') return f.name;
    if (field.name === 'description') return null;
    return null;
  }
  if (typeName === '__Schema') {
    if (field.name === 'types') return [];
    if (field.name === 'queryType') return { __typename: '__Type', name: 'Query', kind: 'OBJECT' };
    if (field.name === 'mutationType') return { __typename: '__Type', name: 'Mutation', kind: 'OBJECT' };
    return null;
  }

  if (typeName === 'Query') {
    if (field.name === 'viewer') {
      const login = ctx.store.viewerLogin;
      if (login === null) return null;
      return { __typename: 'User', login } as UserValue;
    }
    if (field.name === 'repository') {
      const owner = args.owner as string | undefined;
      const name = args.name as string | undefined;
      if (typeof owner !== 'string' || typeof name !== 'string') return null;
      const repo = ctx.store.resolveRepo(owner, name);
      if (repo === null) return null;
      return { __typename: 'Repository', repo } as RepoValue;
    }
    if (field.name === 'node') {
      const id = args.id as string | undefined;
      if (typeof id !== 'string') return null;
      const decoded = decodeGlobalId(id);
      if (decoded === null) return null;
      if (decoded.kind === 'repo') {
        const repo = ctx.store.repoById(Number(decoded.parts[0]));
        return repo === null ? null : ({ __typename: 'Repository', repo } as RepoValue);
      }
      if (decoded.kind === 'issue') {
        const repo = ctx.store.repoById(Number(decoded.parts[0]));
        const issue = repo?.issues.find((i) => i.number === Number(decoded.parts[1]));
        return repo !== undefined && issue !== undefined ? ({ __typename: 'Issue', repo, issue } as IssueValue) : null;
      }
      if (decoded.kind === 'pr') {
        const repo = ctx.store.repoById(Number(decoded.parts[0]));
        const pull = repo?.pulls.find((p) => p.number === Number(decoded.parts[1]));
        return repo !== undefined && pull !== undefined ? ({ __typename: 'PullRequest', repo, pull } as PullValue) : null;
      }
      if (decoded.kind === 'user') {
        return { __typename: 'User', login: decoded.parts[0] ?? '' } as UserValue;
      }
      return null;
    }
    return undefined; // unknown field
  }

  if (typeName === 'Mutation') {
    if (field.name === 'createIssue') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repoId = decodeGlobalId(String(input.repositoryId ?? ''));
      const repo = repoId?.kind === 'repo' ? ctx.store.repoById(Number(repoId.parts[0])) : null;
      if (repo === null) return null;
      const issue: Issue = {
        id: ctx.store.nextId(),
        number: repo.nextIssue++,
        title: String(input.title ?? ''),
        body: typeof input.body === 'string' ? input.body : '',
        state: 'open',
        labels: [],
        userLogin: ctx.store.viewerLogin ?? '',
        comments: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        closedAt: null,
      };
      repo.issues.push(issue);
      return { __typename: 'CreateIssuePayload', issue: { __typename: 'Issue', repo, issue } as IssueValue };
    }
    if (field.name === 'closeIssue') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(String(input.issueId ?? ''));
      if (decoded?.kind !== 'issue') return null;
      const repo = ctx.store.repoById(Number(decoded.parts[0]));
      const issue = repo?.issues.find((i) => i.number === Number(decoded.parts[1]));
      if (repo === undefined || issue === undefined) return null;
      issue.state = 'closed';
      issue.closedAt = new Date().toISOString();
      issue.updatedAt = new Date().toISOString();
      return { __typename: 'CloseIssuePayload', issue: { __typename: 'Issue', repo, issue } as IssueValue };
    }
    if (field.name === 'createPullRequest') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repoId = decodeGlobalId(String(input.repositoryId ?? ''));
      const repo = repoId?.kind === 'repo' ? ctx.store.repoById(Number(repoId.parts[0])) : null;
      if (repo === null) return null;
      const headRef = String(input.headRefName ?? '');
      const baseRef = String(input.baseRefName ?? '');
      const headSha = repo.refs.get(`refs/heads/${headRef}`) ?? '';
      const baseSha = repo.refs.get(`refs/heads/${baseRef}`) ?? '';
      const pull: PullRequest = {
        id: ctx.store.nextId(),
        number: repo.nextPull++,
        title: String(input.title ?? ''),
        body: typeof input.body === 'string' ? input.body : '',
        state: 'open',
        headRef,
        headSha,
        baseRef,
        baseSha,
        userLogin: ctx.store.viewerLogin ?? '',
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      repo.pulls.push(pull);
      return { __typename: 'CreatePullRequestPayload', pullRequest: { __typename: 'PullRequest', repo, pull } as PullValue };
    }
    if (field.name === 'mergePullRequest') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(String(input.pullRequestId ?? ''));
      if (decoded?.kind !== 'pr') return null;
      const repo = ctx.store.repoById(Number(decoded.parts[0]));
      const pull = repo?.pulls.find((p) => p.number === Number(decoded.parts[1]));
      if (repo === undefined || pull === undefined) return null;
      const merged = mergePullRequestInternal(repo, pull);
      if (merged === null) return null;
      return { __typename: 'MergePullRequestPayload', pullRequest: { __typename: 'PullRequest', repo, pull } as PullValue };
    }
    if (field.name === 'addComment') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(String(input.subjectId ?? ''));
      if (decoded?.kind !== 'issue') return null;
      const repo = ctx.store.repoById(Number(decoded.parts[0]));
      const issue = repo?.issues.find((i) => i.number === Number(decoded.parts[1]));
      if (repo === undefined || issue === undefined) return null;
      const comment = {
        id: repo.nextCommentId++,
        body: String(input.body ?? ''),
        userLogin: ctx.store.viewerLogin ?? '',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      issue.comments.push(comment);
      return {
        __typename: 'AddCommentPayload',
        commentEdge: {
          __typename: 'IssueCommentEdge',
          node: { __typename: 'IssueComment', repo, issue, comment },
          cursor: cursorFor(comment.id),
        },
      };
    }
    return undefined; // unknown mutation
  }

  if (typeName === 'Repository') {
    const repo = (value as RepoValue).repo;
    switch (field.name) {
      case 'id': return repoGlobalId(repo);
      case 'databaseId': return repo.id;
      case 'name': return repo.name;
      case 'nameWithOwner': return `${repo.owner ?? ''}/${repo.name}`;
      case 'description': return repo.description;
      case 'isPrivate': return repo.private;
      case 'url': return `https://example.invalid/${repo.owner ?? ''}/${repo.name}`;
      case 'createdAt': return repo.createdAt;
      case 'updatedAt': return repo.updatedAt;
      case 'owner': return { __typename: 'User', login: repo.owner ?? '' } as UserValue;
      case 'viewerPermission': return 'ADMIN';
      case 'hasIssuesEnabled': return true;
      case 'defaultBranchRef': {
        const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        return { __typename: 'Ref', name: repo.defaultBranch, oid: tip ?? null } as RefValue;
      }
      case 'issue': {
        const number = args.number as number | undefined;
        const issue = repo.issues.find((i) => i.number === number);
        return issue === undefined ? null : ({ __typename: 'Issue', repo, issue } as IssueValue);
      }
      case 'issues': {
        const page = paginateIssues(repo, args);
        return { __typename: 'IssueConnection', edges: page.edges, pageInfo: page.pageInfo, totalCount: page.totalCount };
      }
      case 'pullRequest': {
        const number = args.number as number | undefined;
        const pull = repo.pulls.find((p) => p.number === number);
        return pull === undefined ? null : ({ __typename: 'PullRequest', repo, pull } as PullValue);
      }
      case 'pullRequests': {
        const page = paginatePulls(repo, args);
        return { __typename: 'PullRequestConnection', edges: page.edges, pageInfo: page.pageInfo, totalCount: page.totalCount };
      }
      default: return undefined;
    }
  }

  if (typeName === 'Issue') {
    const { repo, issue } = value as IssueValue;
    switch (field.name) {
      case 'id': return issueGlobalId(repo, issue);
      case 'databaseId': return issue.id;
      case 'number': return issue.number;
      case 'title': return issue.title;
      case 'body': return issue.body;
      case 'state': return issueState(issue);
      case 'url': return `https://example.invalid/${repo.owner ?? ''}/${repo.name}/issues/${issue.number}`;
      case 'author': return { __typename: 'User', login: issue.userLogin } as UserValue;
      case 'createdAt': return issue.createdAt;
      case 'updatedAt': return issue.updatedAt;
      case 'labels': return { __typename: 'LabelConnection', nodes: issue.labels.map((l) => ({ __typename: 'Label', name: l.name, color: l.color })) };
      case 'comments': {
        const first = typeof args.first === 'number' ? args.first : 100;
        const nodes = issue.comments.slice(0, first).map((c) => ({ __typename: 'IssueComment', repo, issue, comment: c }));
        return { __typename: 'IssueCommentConnection', nodes, totalCount: issue.comments.length };
      }
      default: return undefined;
    }
  }

  if (typeName === 'PullRequest') {
    const { repo, pull } = value as PullValue;
    switch (field.name) {
      case 'id': return pullGlobalId(repo, pull);
      case 'databaseId': return pull.id;
      case 'number': return pull.number;
      case 'title': return pull.title;
      case 'body': return pull.body;
      case 'state': return pullState(pull);
      case 'merged': return pull.merged;
      case 'mergeable': return pullMergeable(repo, pull);
      case 'headRefName': return pull.headRef;
      case 'baseRefName': return pull.baseRef;
      case 'headRefOid': return pull.headSha;
      case 'url': return `https://example.invalid/${repo.owner ?? ''}/${repo.name}/pull/${pull.number}`;
      case 'author': return { __typename: 'User', login: pull.userLogin } as UserValue;
      case 'createdAt': return pull.createdAt;
      case 'updatedAt': return pull.updatedAt;
      case 'files': {
        const first = typeof args.first === 'number' ? args.first : 100;
        const baseCommit = repo.objects.get(pull.baseSha);
        const headCommit = repo.objects.get(pull.headSha);
        const baseTree = baseCommit?.type === 'commit' ? parseCommit(baseCommit.data).tree : null;
        const headTree = headCommit?.type === 'commit' ? parseCommit(headCommit.data).tree : null;
        const changes = diffTrees(repo, baseTree, headTree).slice(0, Math.max(0, first));
        const nodes = changes.map((c) => ({
          __typename: 'PullRequestChangedFile',
          path: c.filename,
          additions: c.additions,
          deletions: c.deletions,
          changeType: c.status === 'added' ? 'ADDED' : c.status === 'removed' ? 'REMOVED' : 'MODIFIED',
        }));
        return { __typename: 'PullRequestChangedFileConnection', nodes, totalCount: nodes.length, pageInfo: { hasNextPage: false, endCursor: null } };
      }
      default: return undefined;
    }
  }

  if (typeName === 'User') {
    const login = (value as UserValue).login;
    switch (field.name) {
      case 'id': return userGlobalId(login);
      case 'databaseId': return 1;
      case 'login': return login;
      case 'name': return login;
      case 'url': return `https://example.invalid/${login}`;
      case 'avatarUrl': return `https://example.invalid/${login}.png`;
      default: return undefined;
    }
  }

  if (typeName === 'Ref') {
    const ref = value as RefValue;
    if (field.name === 'name') return ref.name;
    if (field.name === 'target') {
      if (ref.oid === null) return null;
      return { __typename: 'Commit', oid: ref.oid };
    }
    return undefined;
  }

  if (typeName === 'Commit') {
    const commit = value as unknown as { oid: string };
    if (field.name === 'oid') return commit.oid;
    if (field.name === 'id') return b64urlEncode(`g:commit:${commit.oid}`);
    return undefined;
  }

  if (typeName === 'IssueConnection' || typeName === 'PullRequestConnection') {
    const conn = value as unknown as { edges: unknown[]; pageInfo: unknown; totalCount: number };
    if (field.name === 'edges') return conn.edges;
    if (field.name === 'nodes') return conn.edges.map((e) => (e as { node: unknown }).node);
    if (field.name === 'pageInfo') return conn.pageInfo;
    if (field.name === 'totalCount') return conn.totalCount;
    return undefined;
  }

  if (typeName === 'IssueEdge' || typeName === 'PullRequestEdge' || typeName === 'IssueCommentEdge') {
    const edge = value as unknown as { node: unknown; cursor: string };
    if (field.name === 'node') return edge.node;
    if (field.name === 'cursor') return edge.cursor;
    return undefined;
  }

  if (typeName === 'PageInfo') {
    const page = value as unknown as Record<string, unknown>;
    if (field.name in page) return page[field.name];
    return undefined;
  }

  if (typeName === 'LabelConnection') {
    const conn = value as unknown as { nodes: unknown[] };
    if (field.name === 'nodes') return conn.nodes;
    if (field.name === 'edges') return conn.nodes.map((n) => ({ node: n, cursor: '' }));
    if (field.name === 'totalCount') return conn.nodes.length;
    return undefined;
  }

  if (typeName === 'IssueCommentConnection') {
    const conn = value as unknown as { nodes: unknown[]; totalCount: number };
    if (field.name === 'nodes') return conn.nodes;
    if (field.name === 'edges') return conn.nodes.map((n) => ({ node: n, cursor: '' }));
    if (field.name === 'totalCount') return conn.totalCount;
    return undefined;
  }

  if (typeName === 'IssueComment') {
    const c = value as unknown as { comment: { id: number; body: string; userLogin: string; createdAt: string }; repo: Repo; issue: Issue };
    if (field.name === 'id') return commentGlobalId(c.repo, c.issue, c.comment.id);
    if (field.name === 'databaseId') return c.comment.id;
    if (field.name === 'body') return c.comment.body;
    if (field.name === 'author') return { __typename: 'User', login: c.comment.userLogin } as UserValue;
    if (field.name === 'createdAt') return c.comment.createdAt;
    return undefined;
  }

  if (typeName === 'PullRequestChangedFileConnection') {
    const conn = value as unknown as { nodes: unknown[]; totalCount: number; pageInfo: unknown };
    if (field.name === 'nodes') return conn.nodes;
    if (field.name === 'edges') return conn.nodes.map((n) => ({ node: n, cursor: '' }));
    if (field.name === 'totalCount') return conn.totalCount;
    if (field.name === 'pageInfo') return conn.pageInfo;
    return undefined;
  }

  if (typeName === 'PullRequestChangedFile') {
    const file = value as unknown as { path: string; additions: number; deletions: number; changeType: string };
    if (field.name === 'path') return file.path;
    if (field.name === 'additions') return file.additions;
    if (field.name === 'deletions') return file.deletions;
    if (field.name === 'changeType') return file.changeType;
    return undefined;
  }

  if (typeName === 'Label') {
    const label = value as unknown as { name: string; color: string };
    if (field.name === 'name') return label.name;
    if (field.name === 'color') return label.color;
    if (field.name === 'id') return b64urlEncode(`g:label:${label.name}`);
    return undefined;
  }

  if (typeName === 'CreateIssuePayload' || typeName === 'CloseIssuePayload') {
    const payload = value as unknown as { issue: IssueValue };
    if (field.name === 'issue') return payload.issue;
    return undefined;
  }
  if (typeName === 'CreatePullRequestPayload' || typeName === 'MergePullRequestPayload') {
    const payload = value as unknown as { pullRequest: PullValue };
    if (field.name === 'pullRequest') return payload.pullRequest;
    return undefined;
  }
  if (typeName === 'AddCommentPayload') {
    const payload = value as unknown as { commentEdge: unknown };
    if (field.name === 'commentEdge') return payload.commentEdge;
    return undefined;
  }

  return undefined;
}

/** Merge a PR the way the REST surface does (squash onto the base branch). Null when refused. */
export function mergePullRequestInternal(repo: Repo, pull: PullRequest): PullRequest | null {
  if (pull.state !== 'open' || pull.merged) return null;
  if (pull.headSha === '' || pull.baseSha === '') return null;
  // The merge parent is the CURRENT base tip, not the baseSha recorded at creation.
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  if (mergeConflicts(repo, baseTip, pull.headSha)) return null;
  const headCommit = repo.objects.get(pull.headSha);
  if (headCommit?.type !== 'commit') return null;
  const treeOid = parseCommit(headCommit.data).tree;
  const stamp = `${Math.floor(Date.now() / 1000)} +0000`;
  const author = `Forge <forge@make.fun> ${stamp}`;
  const commitData = buildCommit({
    tree: treeOid,
    parents: [baseTip],
    author,
    committer: author,
    message: `${pull.title}\n`,
  });
  const mergeSha = hashObject('commit', commitData);
  if (!repo.objects.has(mergeSha)) repo.objects.set(mergeSha, { type: 'commit', data: commitData });
  repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
  pull.baseSha = baseTip;
  pull.merged = true;
  pull.mergedAt = new Date().toISOString();
  pull.mergeCommitSha = mergeSha;
  pull.state = 'closed';
  pull.updatedAt = new Date().toISOString();
  return pull;
}

function executeSelection(
  ctx: ExecContext,
  typeName: string,
  value: Value,
  selections: SelectionNode[],
  path: Array<string | number>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'FragmentSpread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment === undefined) {
        ctx.errors.push({ message: `Unknown fragment "${selection.name}".` });
        continue;
      }
      const sub = executeSelection(ctx, typeName, value, fragment.selection, path);
      Object.assign(out, sub);
      continue;
    }
    if (selection.kind === 'InlineFragment') {
      if (selection.typeCondition !== null && selection.typeCondition !== typeName) continue;
      const sub = executeSelection(ctx, typeName, value, selection.selection, path);
      Object.assign(out, sub);
      continue;
    }
    const responseKey = selection.alias ?? selection.name;
    const resolved = resolveField(ctx, typeName, value, selection);
    if (resolved === undefined) {
      ctx.errors.push({ message: `Cannot query field "${selection.name}" on type "${typeName}".`, path: [...path, responseKey] });
      out[responseKey] = null;
      continue;
    }
    out[responseKey] = completeValue(ctx, selection, resolved, [...path, responseKey]);
  }
  return out;
}

function completeValue(
  ctx: ExecContext,
  field: FieldNode,
  resolved: unknown,
  path: Array<string | number>,
): unknown {
  if (resolved === null || resolved === undefined) return null;
  if (field.selection === null) return resolved;
  if (Array.isArray(resolved)) {
    return resolved.map((entry, index) => {
      const typeName = typenameOf(entry as Value) ?? 'Unknown';
      if (typeName === 'Unknown') return entry;
      return executeSelection(ctx, typeName, entry as Value, field.selection!, [...path, index]);
    });
  }
  const typeName = typenameOf(resolved as Value);
  if (typeName === null) return resolved;
  return executeSelection(ctx, typeName, resolved as Value, field.selection, path);
}

export function executeGraphQL(
  store: Store,
  documentSrc: string,
  variables: Record<string, unknown>,
): { data: Record<string, unknown> | null; errors: GraphQLError[] } {
  const errors: GraphQLError[] = [];
  let document: DocumentNode;
  try {
    document = parseDocument(documentSrc);
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  const operation = document.operations[0];
  if (operation === undefined) return { data: null, errors: [{ message: 'No operation in document.' }] };
  const vars: Record<string, unknown> = { ...variables };
  for (const varDef of operation.variables) {
    if (!(varDef.name in vars) && varDef.defaultValue !== null) {
      vars[varDef.name] = valueFromNode(varDef.defaultValue, vars);
    }
  }
  const ctx: ExecContext = { store, variables: vars, errors, fragments: document.fragments };
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelection(ctx, rootType, {}, operation.selection, []);
  return { data, errors };
}
