// git.ts — git object model, pkt-line framing and packfiles (Node 22 stdlib only).
// Pure functions: no I/O, no state. Written from the git smart-HTTP wire format
// (protocol v0/v2) and the pack format as the conformance suite's client speaks them.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0'.repeat(40);
export const PKT_LINE_MAX = 65520;

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

/** SHA-1 object id of `<type> <size>\0<data>`. */
export function hashObject(type: GitObjectType, data: Uint8Array): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export function isObjectId(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

// ---------------------------------------------------------------- pkt-lines

export function encodePktLine(payload: string | Uint8Array): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.from(payload);
  const len = body.length + 4;
  if (len > PKT_LINE_MAX) throw new Error(`pkt-line of ${len} bytes exceeds ${PKT_LINE_MAX}`);
  const head = Buffer.alloc(4);
  head.write(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

export function pktLineFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktLineDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export function encodePktLines(lines: Array<string | 'flush' | 'delim'>): Buffer {
  const parts: Buffer[] = [];
  for (const line of lines) {
    if (line === 'flush') parts.push(pktLineFlush());
    else if (line === 'delim') parts.push(pktLineDelim());
    else parts.push(encodePktLine(line));
  }
  return Buffer.concat(parts);
}

export type GitPacket =
  | { kind: 'data'; payload: Buffer; raw: Buffer }
  | { kind: 'flush'; raw: Buffer }
  | { kind: 'delim'; raw: Buffer }
  | { kind: 'response-end'; raw: Buffer };

/** Decode a whole pkt-line stream. Throws on a malformed length prefix. */
export function decodePktLines(bytes: Uint8Array): GitPacket[] {
  const packets: GitPacket[] = [];
  let offset = 0;
  const buf = Buffer.from(bytes);
  while (offset < buf.length) {
    if (offset + 4 > buf.length) throw new Error('truncated pkt-line length');
    const head = buf.subarray(offset, offset + 4).toString('ascii');
    if (head === '0000') {
      packets.push({ kind: 'flush', raw: buf.subarray(offset, offset + 4) });
      offset += 4;
      continue;
    }
    if (head === '0001') {
      packets.push({ kind: 'delim', raw: buf.subarray(offset, offset + 4) });
      offset += 4;
      continue;
    }
    if (head === '0002') {
      packets.push({ kind: 'response-end', raw: buf.subarray(offset, offset + 4) });
      offset += 4;
      continue;
    }
    const len = parseInt(head, 16);
    if (!Number.isFinite(len) || len < 4 || offset + len > buf.length) {
      throw new Error(`bad pkt-line length ${JSON.stringify(head)}`);
    }
    packets.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + len), raw: buf.subarray(offset, offset + len) });
    offset += len;
  }
  return packets;
}

/** Split a byte stream into pkt-lines, tolerating trailing raw bytes (a pack after a flush). */
export function splitPktLines(bytes: Uint8Array): { packets: GitPacket[]; rest: Buffer } {
  const packets: GitPacket[] = [];
  let offset = 0;
  const buf = Buffer.from(bytes);
  while (offset + 4 <= buf.length) {
    const head = buf.subarray(offset, offset + 4).toString('ascii');
    if (head === '0000' || head === '0001' || head === '0002') {
      const kind = head === '0000' ? 'flush' : head === '0001' ? 'delim' : 'response-end';
      packets.push({ kind, raw: buf.subarray(offset, offset + 4) } as GitPacket);
      offset += 4;
      // A flush ends the command section of a receive-pack request: the pack follows raw.
      if (kind === 'flush') break;
      continue;
    }
    const len = parseInt(head, 16);
    if (!Number.isFinite(len) || len < 4 || offset + len > buf.length) break;
    packets.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + len), raw: buf.subarray(offset, offset + len) });
    offset += len;
  }
  return { packets, rest: buf.subarray(offset) };
}

// ---------------------------------------------------------------- trees / commits / tags

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Uint8Array): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  const buf = Buffer.from(data);
  while (offset < buf.length) {
    const space = buf.indexOf(0x20, offset);
    if (space < 0) throw new Error('malformed tree entry (no mode)');
    const mode = buf.subarray(offset, space).toString('ascii');
    const nul = buf.indexOf(0, space + 1);
    if (nul < 0) throw new Error('malformed tree entry (no name)');
    const name = buf.subarray(space + 1, nul).toString('utf8');
    const oid = buf.subarray(nul + 1, nul + 21).toString('hex');
    if (oid.length !== 40) throw new Error('malformed tree entry (short oid)');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Git tree sort: entries by name, directories sorting as if named `name/`. */
function compareTreeEntries(a: TreeEntry, b: TreeEntry): number {
  const an = a.mode === '40000' ? `${a.name}/` : a.name;
  const bn = b.mode === '40000' ? `${b.name}/` : b.name;
  return an < bn ? -1 : an > bn ? 1 : 0;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeEntries);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Uint8Array): CommitView {
  const text = Buffer.from(data).toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(fields: {
  tree: string;
  parents: readonly string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author}`);
  lines.push(`committer ${fields.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${fields.message}`, 'utf8');
}

export interface TagView {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Uint8Array): TagView {
  const text = Buffer.from(data).toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

export function buildTag(fields: { object: string; type: string; tag: string; tagger: string; message: string }): Buffer {
  return Buffer.from(
    `object ${fields.object}\ntype ${fields.type}\ntag ${fields.tag}\ntagger ${fields.tagger}\n\n${fields.message}`,
    'utf8',
  );
}

// ---------------------------------------------------------------- reachability

export type ObjectLookup = (oid: string) => GitObject | undefined;

/**
 * All objects reachable from `roots` (commits walk parents + trees + blobs; tags follow
 * their target). `stopAt` commits are included themselves but their parents are not walked
 * (shallow boundaries). Throws when a referenced object is missing.
 */
export function collectReachable(
  roots: readonly string[],
  lookup: ObjectLookup,
  stopAt?: ReadonlySet<string>,
): Set<string> {
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid) || !isObjectId(oid) || oid === ZERO_OID) continue;
    const object = lookup(oid);
    if (object === undefined) throw new Error(`missing object ${oid}`);
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      if (commit.tree !== '') stack.push(commit.tree);
      if (stopAt !== undefined && stopAt.has(oid)) continue;
      for (const parent of commit.parents) stack.push(parent);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    }
  }
  return seen;
}

/** Commit-only ancestor walk from `roots` (used for merge-base and history listing). */
export function collectAncestors(roots: readonly string[], lookup: ObjectLookup): Set<string> {
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid) || !isObjectId(oid) || oid === ZERO_OID) continue;
    const object = lookup(oid);
    if (object === undefined || object.type !== 'commit') continue;
    seen.add(oid);
    for (const parent of parseCommit(object.data).parents) stack.push(parent);
  }
  return seen;
}

// ---------------------------------------------------------------- packfiles

const PACK_TYPES: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const PACK_TYPE_IDS: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buffer[start]!;
  const first = (byte >> 4) & 7;
  let size = byte & 15;
  let shift = 4;
  let next = start + 1;
  while (byte & 0x80) {
    byte = buffer[next]!;
    size |= (byte & 0x7f) << shift;
    shift += 7;
    next += 1;
  }
  return { size, next, first };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buffer[start]!;
  let offset = byte & 0x7f;
  let next = start + 1;
  while (byte & 0x80) {
    byte = buffer[next]!;
    offset = ((offset + 1) << 7) | (byte & 0x7f);
    next += 1;
  }
  return { baseOffset: offset, next };
}

/** Inflate one zlib stream at `offset`; returns the data and the offset just past it. */
export function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const result = inflateSync(buffer.subarray(offset), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error('zlib stream consumed no bytes');
  return { data: result.buffer, next: offset + written };
}

/** Apply a git binary delta to `base`. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset]!;
      offset += 1;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  const targetSize = readVarint();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset]!;
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          copyOffset += delta[offset]! * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          copySize += delta[offset]! * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy is out of the base');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      delta.copy(out, written, offset, offset + literal);
      written += literal;
      offset += literal;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (written !== targetSize) throw new Error('delta result size mismatch');
  return out;
}

export interface PackReadResult {
  objects: Map<string, GitObject>;
  deltaCount: number;
  declaredCount: number;
  version: number;
}

function inflateWithLength(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  return inflateAt(buffer, offset);
}

/** Read a packfile (v2/v3), resolving OFS_DELTA / REF_DELTA entries. */
export function readPack(pack: Uint8Array, options: { resolveBase?: ObjectLookup } = {}): PackReadResult {
  const buf = Buffer.from(pack);
  if (buf.length < 12 || buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = buf.readUInt32BE(8);
  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, GitObject>();
  let offset = 12;
  let deltaCount = 0;
  const pendingRefDeltas: Array<{ baseOid: string; delta: Buffer; offset: number }> = [];
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const { size, next, first: typeId } = readVarintSize(buf, offset);
    offset = next;
    if (typeId === 6) {
      // OFS_DELTA
      const { baseOffset, next: afterBase } = readOfsDeltaBase(buf, offset);
      offset = afterBase;
      const { data: delta, next: afterData } = inflateWithLength(buf, offset);
      offset = afterData;
      const baseEntry = byOffset.get(entryOffset - baseOffset);
      if (baseEntry === undefined) throw new Error('OFS_DELTA base not found');
      const data = applyDelta(baseEntry.data, delta);
      const object: GitObject = { type: baseEntry.type, data };
      const oid = hashObject(object.type, object.data);
      objects.set(oid, object);
      byOffset.set(entryOffset, object);
      deltaCount += 1;
    } else if (typeId === 7) {
      // REF_DELTA
      const baseOid = buf.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      const { data: delta, next: afterData } = inflateWithLength(buf, offset);
      offset = afterData;
      pendingRefDeltas.push({ baseOid, delta, offset: entryOffset });
      deltaCount += 1;
    } else {
      const type = PACK_TYPES[typeId];
      if (type === undefined) throw new Error(`unknown pack object type ${typeId}`);
      const { data, next: afterData } = inflateWithLength(buf, offset);
      offset = afterData;
      if (data.length !== size) throw new Error('pack object size mismatch');
      const object: GitObject = { type, data };
      const oid = hashObject(type, data);
      objects.set(oid, object);
      byOffset.set(entryOffset, object);
    }
  }
  for (const pending of pendingRefDeltas) {
    const base = objects.get(pending.baseOid) ?? options.resolveBase?.(pending.baseOid);
    if (base === undefined) throw new Error(`REF_DELTA base ${pending.baseOid} not found`);
    const data = applyDelta(base.data, pending.delta);
    const object: GitObject = { type: base.type, data };
    objects.set(hashObject(object.type, object.data), object);
  }
  return { objects, deltaCount, declaredCount, version };
}

export function verifyPackChecksum(pack: Uint8Array): { ok: boolean; expected: string; actual: string } {
  const buf = Buffer.from(pack);
  if (buf.length < 20) return { ok: false, expected: '', actual: '' };
  const expected = createHash('sha1').update(buf.subarray(0, buf.length - 20)).digest('hex');
  const actual = buf.subarray(buf.length - 20).toString('hex');
  return { ok: expected === actual, expected, actual };
}

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const typeId = PACK_TYPE_IDS[type];
  const bytes: number[] = [];
  let first = (typeId << 4) | (size & 15);
  let remaining = size >> 4;
  if (remaining > 0) first |= 0x80;
  bytes.push(first);
  while (remaining > 0) {
    let byte = remaining & 0x7f;
    remaining >>= 7;
    if (remaining > 0) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

/** Write a v2 pack of plain (non-delta) objects. */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  const parts: Buffer[] = [header];
  for (const object of list) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/**
 * Shallow fetch planning. Returns the object set to send plus the shallow-info lists.
 * `depth` limits commit generations from the wants (1 = tips only). `haves` are excluded
 * along with everything reachable from them, except that traversal stops at `shallow`
 * boundaries (those commits are included, their parents are not).
 */
export function planFetch(
  wants: readonly string[],
  haves: readonly string[],
  depth: number | null,
  shallowBoundaries: readonly string[],
  lookup: ObjectLookup,
): { objects: Map<string, GitObject>; shallow: string[]; unshallow: string[] } {
  const boundarySet = new Set(shallowBoundaries.filter(isObjectId));
  // Commit generations from the wants (tags resolve to their target commit first).
  const wantCommits = new Map<string, number>(); // oid -> generation
  const queue: Array<{ oid: string; gen: number }> = [];
  const nonCommitRoots: string[] = [];
  for (const want of wants) {
    if (!isObjectId(want)) continue;
    const object = lookup(want);
    if (object === undefined) continue;
    if (object.type === 'commit') queue.push({ oid: want, gen: 0 });
    else if (object.type === 'tag') {
      const target = parseTag(object.data).object;
      const targetObj = lookup(target);
      if (targetObj?.type === 'commit') queue.push({ oid: target, gen: 0 });
      else if (targetObj !== undefined) nonCommitRoots.push(target);
      nonCommitRoots.push(want);
    } else {
      nonCommitRoots.push(want);
    }
  }
  const maxGen = depth === null ? Number.POSITIVE_INFINITY : depth - 1;
  const shallow: string[] = [];
  while (queue.length > 0) {
    const { oid, gen } = queue.shift()!;
    const known = wantCommits.get(oid);
    if (known !== undefined && known <= gen) continue;
    wantCommits.set(oid, gen);
    if (gen >= maxGen) continue;
    const object = lookup(oid);
    if (object?.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (!wantCommits.has(parent)) queue.push({ oid: parent, gen: gen + 1 });
    }
  }
  // Boundary commits: included at the deepest generation that still have parents.
  if (depth !== null) {
    for (const [oid, gen] of wantCommits) {
      if (gen !== maxGen) continue;
      const object = lookup(oid);
      if (object?.type === 'commit' && parseCommit(object.data).parents.length > 0) shallow.push(oid);
    }
  }
  // Object closure of the wanted commits + non-commit roots. Depth-limited: a commit's
  // tree is always fully included, but parents are followed only when they are themselves
  // inside the depth window (wantCommits).
  const wantClosure = new Set<string>();
  const stack: string[] = [...wantCommits.keys(), ...nonCommitRoots];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (wantClosure.has(oid) || !isObjectId(oid) || oid === ZERO_OID) continue;
    const object = lookup(oid);
    if (object === undefined) continue;
    wantClosure.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      if (commit.tree !== '') stack.push(commit.tree);
      for (const parent of commit.parents) {
        if (wantCommits.has(parent)) stack.push(parent);
      }
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      const target = parseTag(object.data).object;
      const targetObj = lookup(target);
      if (targetObj?.type === 'commit') {
        if (wantCommits.has(target)) stack.push(target);
      } else {
        stack.push(target);
      }
    }
  }
  // Have closure: everything the client already holds (stops at shallow boundaries).
  const haveClosure = new Set<string>();
  for (const have of haves) {
    if (!isObjectId(have)) continue;
    try {
      for (const reached of collectReachable([have], lookup, boundarySet)) haveClosure.add(reached);
    } catch {
      // A have the server does not know is ignored (thin-pack base resolution is client-side).
    }
  }
  const objects = new Map<string, GitObject>();
  for (const oid of wantClosure) {
    if (haveClosure.has(oid)) continue;
    const object = lookup(oid);
    if (object !== undefined) objects.set(oid, object);
  }
  // unshallow: previous boundaries that are now strictly inside the included generations.
  const unshallow: string[] = [];
  if (depth !== null) {
    for (const oid of boundarySet) {
      const gen = wantCommits.get(oid);
      if (gen !== undefined && gen < maxGen && !shallow.includes(oid)) unshallow.push(oid);
    }
  } else {
    for (const oid of boundarySet) {
      if (wantCommits.has(oid) && !shallow.includes(oid)) unshallow.push(oid);
    }
  }
  return { objects, shallow, unshallow };
}
