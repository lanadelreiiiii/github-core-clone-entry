// app.ts — the forge's HTTP server: git smart HTTP (v0/v2), REST v3, GraphQL v4
// and the MCP endpoint. Node 22 stdlib only (node:http, node:crypto, node:zlib).
// In-memory store; no persistence, no network calls.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  ZERO_OID,
  decodePktLines,
  encodePktLine,
  encodePktLines,
  isObjectId,
  parseTag,
  planFetch,
  pktLineDelim,
  pktLineFlush,
  readPack,
  splitPktLines,
  verifyPackChecksum,
  writePack,
  type GitObject,
} from './git.ts';
import { executeGraphQL } from './graphql.ts';
import { MCP_REVISIONS, MCP_SERVER_NAME, MCP_SERVER_VERSION, MCP_TOOLS, callMcpTool } from './mcp.ts';
import { handleRest, type RestReply } from './rest.ts';
import { Store, isAncestor, type Repo } from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const AGENT = 'github-core-clone/1.0.0';

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `req_${requestCounter.toString(36)}_${Date.now().toString(36)}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

function sendBuffer(res: ServerResponse, status: number, body: Buffer, contentType: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, ...headers });
  res.end(body);
}

function sendText(res: ServerResponse, status: number, text: string, contentType = 'text/plain; charset=utf-8'): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

function readBody(req: IncomingMessage, maxBytes = 32 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  return token === '' ? null : token;
}

// ---------------------------------------------------------------- git smart HTTP

interface AdvertiseRefs {
  head: string | null;
  refs: Array<{ oid: string; name: string; peeled?: string }>;
}

function advertisedRefs(repo: Repo): AdvertiseRefs {
  const refs: Array<{ oid: string; name: string; peeled?: string }> = [];
  const names = [...repo.refs.keys()].sort();
  let head: string | null = null;
  const mainTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (mainTip !== undefined) head = mainTip;
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    const entry: { oid: string; name: string; peeled?: string } = { oid, name };
    if (name.startsWith('refs/tags/')) {
      const object = repo.objects.get(oid);
      if (object?.type === 'tag') entry.peeled = parseTag(object.data).object;
    }
    refs.push(entry);
  }
  return { head, refs };
}

function v2Advertisement(): Buffer {
  const lines: Buffer[] = [
    encodePktLine('# service=git-upload-pack\n'),
    pktLineFlush(),
    encodePktLine('version 2\n'),
    encodePktLine('ls-refs=unborn\n'),
    encodePktLine('fetch=shallow filter\n'),
    encodePktLine('object-format=sha1\n'),
    encodePktLine(`agent=${AGENT}\n`),
    pktLineFlush(),
  ];
  return Buffer.concat(lines);
}

function v0Advertisement(service: 'git-upload-pack' | 'git-receive-pack', repo: Repo): Buffer {
  const { head, refs } = advertisedRefs(repo);
  const caps =
    service === 'git-upload-pack'
      ? `side-band-64k thin-pack multi_ack ofs-delta shallow symref=HEAD:refs/heads/${repo.defaultBranch} agent=${AGENT}`
      : `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
  const parts: Buffer[] = [encodePktLine(`# service=${service}\n`), pktLineFlush()];
  if (refs.length === 0) {
    parts.push(encodePktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    let first = true;
    if (head !== null) {
      parts.push(encodePktLine(`${head} HEAD${first ? `\0${caps}` : ''}\n`));
      first = false;
    }
    for (const ref of refs) {
      parts.push(encodePktLine(`${ref.oid} ${ref.name}${first ? `\0${caps}` : ''}\n`));
      first = false;
      if (ref.peeled !== undefined) parts.push(encodePktLine(`${ref.peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(pktLineFlush());
  return Buffer.concat(parts);
}

function sidebandPack(pack: Buffer): Buffer {
  // One sideband packet per ≤65515 bytes of pack data (band byte + payload in a pkt-line).
  const parts: Buffer[] = [];
  const CHUNK = PKT_LINE_MAX - 5;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const slice = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    const payload = Buffer.concat([Buffer.from([1]), slice]);
    parts.push(encodePktLine(payload));
  }
  if (pack.length === 0) {
    parts.push(encodePktLine(Buffer.from([1])));
  }
  return Buffer.concat(parts);
}

const PKT_LINE_MAX = 65520;

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

/** Parse a v2 fetch/ls-refs request body into its argument lines (delim-aware). */
function v2ArgLines(packets: ReturnType<typeof decodePktLines>): string[] {
  const lines: string[] = [];
  let inArgs = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      inArgs = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8');
    if (!inArgs) continue; // command= / agent= / object-format= lines before the delim
    lines.push(text);
  }
  return lines;
}

function parseV2FetchArgs(argLines: string[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null };
  for (const line of argLines) {
    if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) args.depth = Number(line.slice(7).trim());
  }
  return args;
}

function handleUploadPackV2(repo: Repo, body: Buffer): Buffer {
  let packets;
  try {
    packets = decodePktLines(body);
  } catch {
    throw new Error('malformed pkt-line stream');
  }
  const headerLines = packets.filter((p) => p.kind === 'data').map((p) => p.payload.toString('utf8'));
  const command = headerLines.find((l) => l.startsWith('command='))?.slice('command='.length).trim() ?? '';
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);

  if (command === 'ls-refs') {
    const argLines = v2ArgLines(packets);
    let peel = false;
    let symrefs = false;
    const prefixes: string[] = [];
    for (const line of argLines) {
      const text = line.trim();
      if (text === 'peel') peel = true;
      else if (text === 'symrefs') symrefs = true;
      else if (text.startsWith('ref-prefix ')) prefixes.push(text.slice('ref-prefix '.length).trim());
    }
    const { head, refs } = advertisedRefs(repo);
    const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
    const out: Buffer[] = [];
    const headLine = head === null ? `unborn HEAD${symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n` : `${head} HEAD${symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`;
    if (keep('HEAD')) out.push(encodePktLine(headLine));
    for (const ref of refs) {
      if (!keep(ref.name)) continue;
      let line = `${ref.oid} ${ref.name}`;
      if (peel && ref.peeled !== undefined) line += ` peeled:${ref.peeled}`;
      out.push(encodePktLine(`${line}\n`));
    }
    out.push(pktLineFlush());
    return Buffer.concat(out);
  }

  if (command !== 'fetch') throw new Error(`unknown v2 command ${JSON.stringify(command)}`);
  const args = parseV2FetchArgs(v2ArgLines(packets));
  const plan = planFetch(args.wants, args.haves, args.depth, args.shallow, lookup);
  const pack = writePack(plan.objects.values());
  const parts: Buffer[] = [];
  parts.push(encodePktLine('acknowledgments\n'));
  const knownHaves = args.haves.filter((h) => repo.objects.has(h));
  if (knownHaves.length === 0) parts.push(encodePktLine('NAK\n'));
  else for (const have of knownHaves) parts.push(encodePktLine(`ACK ${have}\n`));
  parts.push(pktLineDelim());
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(encodePktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
    parts.push(pktLineDelim());
  }
  parts.push(encodePktLine('packfile\n'));
  parts.push(sidebandPack(pack));
  parts.push(pktLineFlush());
  return Buffer.concat(parts);
}

function handleUploadPackV0(repo: Repo, body: Buffer): Buffer {
  const { packets } = splitPktLines(body);
  const lines = packets.filter((p) => p.kind === 'data').map((p) => p.payload.toString('utf8'));
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null };
  for (const line of lines) {
    const text = line.replace(/\n$/, '');
    if (text.startsWith('want ')) args.wants.push(text.slice(5).split(' ')[0]!);
    else if (text.startsWith('have ')) args.haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) args.shallow.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) args.depth = Number(text.slice(7).trim());
  }
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const plan = planFetch(args.wants, args.haves, args.depth, args.shallow, lookup);
  const pack = writePack(plan.objects.values());
  const parts: Buffer[] = [];
  const knownHaves = args.haves.filter((h) => repo.objects.has(h));
  if (knownHaves.length === 0) parts.push(encodePktLine('NAK\n'));
  else for (const have of knownHaves) parts.push(encodePktLine(`ACK ${have}\n`));
  for (const oid of plan.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
  parts.push(sidebandPack(pack));
  parts.push(pktLineFlush());
  return Buffer.concat(parts);
}

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function handleReceivePack(repo: Repo, body: Buffer): Buffer {
  const { packets, rest } = splitPktLines(body);
  const commands: PushCommand[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul >= 0) line = line.slice(0, nul);
    const parts = line.split(' ');
    if (parts.length < 3) continue;
    commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! });
  }
  const reportLines: string[] = [];
  let unpackOk = true;
  let unpackDetail = 'ok';
  // Unpack the pack (if any) first: objects land in the store even for refused refs.
  if (rest.length > 0) {
    try {
      const checksum = verifyPackChecksum(rest);
      if (!checksum.ok) throw new Error('pack trailer checksum mismatch');
      const read = readPack(rest);
      for (const [oid, object] of read.objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : String(err);
    }
  }
  reportLines.push(`unpack ${unpackOk ? 'ok' : unpackDetail}\n`);
  if (unpackOk) {
    for (const command of commands) {
      const current = repo.refs.get(command.ref);
      let ok = true;
      let reason = '';
      if (!isObjectId(command.oldOid) || !isObjectId(command.newOid)) {
        ok = false;
        reason = 'invalid object id';
      } else if (command.newOid === ZERO_OID) {
        // Delete.
        if (current === undefined) {
          ok = false;
          reason = 'ref does not exist';
        } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
          ok = false;
          reason = 'non-fast-forward';
        }
      } else {
        const object = repo.objects.get(command.newOid);
        if (object === undefined) {
          ok = false;
          reason = 'object not found';
        } else if (current === undefined) {
          if (command.oldOid !== ZERO_OID) {
            ok = false;
            reason = 'non-fast-forward';
          }
        } else if (command.oldOid !== current) {
          ok = false;
          reason = 'non-fast-forward';
        } else if (!isAncestor(repo, current, command.newOid)) {
          ok = false;
          reason = 'non-fast-forward';
        }
      }
      if (ok) {
        if (command.newOid === ZERO_OID) repo.refs.delete(command.ref);
        else repo.refs.set(command.ref, command.newOid);
        reportLines.push(`ok ${command.ref}\n`);
      } else {
        reportLines.push(`ng ${command.ref} ${reason}\n`);
      }
    }
  } else {
    for (const command of commands) reportLines.push(`ng ${command.ref} unpack failed\n`);
  }
  const report = encodePktLines(reportLines);
  const banded = Buffer.concat([Buffer.from([1]), report]);
  return Buffer.concat([encodePktLine(banded), pktLineFlush()]);
}

// ---------------------------------------------------------------- MCP

function handleMcp(store: Store, body: Buffer): { status: number; body: unknown } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return {
      status: 400,
      body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
    };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      status: 400,
      body: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } },
    };
  }
  const request = parsed as { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };
  const id = request.id ?? null;
  const method = request.method ?? '';
  const params = (request.params ?? {}) as Record<string, unknown>;
  const result = (value: unknown): { status: number; body: unknown } => ({
    status: 200,
    body: { jsonrpc: '2.0', id, result: value },
  });
  const error = (code: number, message: string): { status: number; body: unknown } => ({
    status: 200,
    body: { jsonrpc: '2.0', id, error: { code, message } },
  });

  if (method === 'server/discover') {
    const serverInfo = { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION };
    return result({
      supportedVersions: [...MCP_REVISIONS],
      capabilities: { tools: {} },
      serverInfo,
      _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
    });
  }
  if (method === 'initialize') {
    const wanted = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const negotiated = MCP_REVISIONS.includes(wanted) ? wanted : '2025-11-25';
    return result({
      protocolVersion: negotiated,
      capabilities: { tools: {} },
      serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    });
  }
  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    return { status: 202, body: {} };
  }
  if (method === 'tools/list') {
    return result({ tools: MCP_TOOLS });
  }
  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    if (!MCP_TOOLS.some((t) => t.name === name)) {
      return error(-32601, `unknown tool ${name}`);
    }
    const outcome = callMcpTool(store, name, args);
    if (!outcome.ok) {
      return result({
        content: [{ type: 'text', text: outcome.errorMessage ?? 'tool call failed' }],
        isError: true,
      });
    }
    return result({
      content: [{ type: 'text', text: JSON.stringify(outcome.result) }],
      structuredContent: outcome.result,
      isError: false,
    });
  }
  return error(-32601, `method not found: ${method}`);
}

// ---------------------------------------------------------------- server

export function createApp(store = new Store()): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const method = req.method ?? 'GET';
        const path = pathOf(req);
        const query = queryOf(req);
        const segments = path.split('/').filter((s) => s !== '');

        // Health probe (starter behavior, no auth).
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        // API root (starter behavior, no auth).
        if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
          sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org', 'x-github-request-id': nextRequestId() });
          return;
        }

        // Git smart HTTP: /{owner}/{repo}.git/...
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(.*)$/.exec(path);
        if (gitMatch !== null) {
          const owner = decodeURIComponent(gitMatch[1]!);
          const repoName = decodeURIComponent(gitMatch[2]!);
          const suffix = gitMatch[3]!;
          const repo = store.resolveRepo(owner, repoName);
          if (repo === null) {
            sendText(res, 404, 'Not Found');
            return;
          }
          if (method === 'GET' && suffix === 'info/refs') {
            const service = query.get('service');
            if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
              sendText(res, 400, 'unknown service');
              return;
            }
            const wantsV2 = service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '') === 'version=2';
            const body = wantsV2 ? v2Advertisement() : v0Advertisement(service, repo);
            sendBuffer(res, 200, body, `application/x-${service}-advertisement`);
            return;
          }
          if (method === 'POST' && suffix === 'git-upload-pack') {
            const body = await readBody(req);
            try {
              const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
              const out = isV2 ? handleUploadPackV2(repo, body) : handleUploadPackV0(repo, body);
              sendBuffer(res, 200, out, 'application/x-git-upload-pack-result');
            } catch (err) {
              sendText(res, 400, err instanceof Error ? err.message : 'bad request');
            }
            return;
          }
          if (method === 'POST' && suffix === 'git-receive-pack') {
            const body = await readBody(req);
            try {
              const out = handleReceivePack(repo, body);
              sendBuffer(res, 200, out, 'application/x-git-receive-pack-result');
            } catch (err) {
              sendText(res, 400, err instanceof Error ? err.message : 'bad request');
            }
            return;
          }
          sendText(res, 404, 'Not Found');
          return;
        }

        // REST v3 (auth required except the root handled above).
        if (segments[0] === 'api' && segments[1] === 'v3') {
          if (bearerToken(req) === null) {
            sendJson(res, 401, { message: 'Requires authentication' }, { 'x-github-request-id': nextRequestId() });
            return;
          }
          const body = await readBody(req).catch(() => null);
          let parsedBody: unknown;
          if (body !== null && body.length > 0) {
            try {
              parsedBody = JSON.parse(body.toString('utf8'));
            } catch {
              sendJson(res, 400, { message: 'Problems parsing JSON' }, { 'x-github-request-id': nextRequestId() });
              return;
            }
          }
          const host = req.headers.host ?? '127.0.0.1';
          const baseUrl = `http://${host}`;
          const reply: RestReply | null = handleRest({
            store,
            method,
            segments: segments.slice(2),
            query,
            body: parsedBody,
            baseUrl,
          });
          if (reply === null) {
            sendJson(res, 404, { message: 'Not Found' }, { 'x-github-request-id': nextRequestId() });
            return;
          }
          if ('empty' in reply && reply.empty) {
            res.writeHead(reply.status, { 'x-github-request-id': nextRequestId(), ...(reply.headers ?? {}) });
            res.end();
            return;
          }
          sendJson(res, reply.status, reply.body, { 'x-github-request-id': nextRequestId(), ...(reply.headers ?? {}) });
          return;
        }

        // GraphQL v4.
        if (path === '/api/graphql') {
          if (method !== 'POST') {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          if (bearerToken(req) === null) {
            sendJson(res, 401, { message: 'Requires authentication' });
            return;
          }
          const body = await readBody(req);
          let parsed: unknown;
          try {
            parsed = JSON.parse(body.toString('utf8'));
          } catch {
            sendJson(res, 400, { message: 'Problems parsing JSON' });
            return;
          }
          if (Array.isArray(parsed)) {
            const out = parsed.map((entry) => {
              const record = (entry ?? {}) as Record<string, unknown>;
              const { data, errors } = executeGraphQL(store, String(record.query ?? ''), (record.variables ?? {}) as Record<string, unknown>);
              return errors.length > 0 ? { data, errors } : { data };
            });
            sendJson(res, 200, out);
            return;
          }
          const record = (parsed ?? {}) as Record<string, unknown>;
          const { data, errors } = executeGraphQL(store, String(record.query ?? ''), (record.variables ?? {}) as Record<string, unknown>);
          sendJson(res, 200, errors.length > 0 ? { data, errors } : { data });
          return;
        }

        // MCP.
        if (path === '/mcp') {
          if (method === 'GET' || method === 'DELETE') {
            // No session-based streaming: a GET opens nothing; DELETE without a session is a no-op.
            if (method === 'DELETE') {
              res.writeHead(200, { 'content-type': JSON_TYPE });
              res.end('{}\n');
              return;
            }
            sendJson(res, 405, { message: 'Method Not Allowed' });
            return;
          }
          if (method !== 'POST') {
            sendJson(res, 405, { message: 'Method Not Allowed' });
            return;
          }
          if (bearerToken(req) === null) {
            sendJson(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } });
            return;
          }
          const body = await readBody(req);
          const { status, body: out } = handleMcp(store, body);
          if (status === 202) {
            res.writeHead(202);
            res.end();
            return;
          }
          sendJson(res, status, out);
          return;
        }

        // Everything else: GitHub's 404 body.
        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        try {
          sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
        } catch {
          // The response is already gone; nothing left to do.
        }
      }
    })();
  });
}
