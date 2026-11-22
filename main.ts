// main.ts is mend, the CLI SPEC.md specifies. Node 22, the standard library alone;
// run it as `node main.ts [options] [PATCH]`.
//
// Sections 1 to 4, 9 and 10 of SPEC.md (command line, output and exit codes, safe paths,
// format detection, JSON edits, all-or-nothing write) follow the kit starter; sections 5
// to 8 (three-tier line matching, unified diffs, SEARCH/REPLACE blocks, V4A patches) and
// the `R old -> new` output line for moves are implemented here.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
  recordMove(oldP: string, newP: string): void {
    this.moves.push([oldP, newP]);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Section 3: a file as lines, with its own break and final-break flag.
// ---------------------------------------------------------------------------

interface FileLines {
  lines: string[];
  br: '\r\n' | '\n';
  final: boolean;
}

function splitFile(text: string): FileLines {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br: '\r\n' | '\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const final = text.endsWith(br);
  const parts = text.split(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(f: FileLines): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

// ---------------------------------------------------------------------------
// Section 5: matching lines at three tiers.
// ---------------------------------------------------------------------------

function normLine(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function occurrences(file: string[], O: string[], tier: number): number[] {
  const res: number[] = [];
  if (O.length === 0) return res;
  for (let i = 0; i + O.length <= file.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (normLine(file[i + j]!, tier) !== normLine(O[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) res.push(i);
  }
  return res;
}

function findTier(file: string[], O: string[], strict: boolean): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(file, O, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

interface NLine {
  text: string;
  ctx: boolean;
  oIdx?: number;
}

const leadingWs = (s: string): string => /^[ \t]*/.exec(s)![0];

/** Re-indent the non-context lines of N at tier 2; context lines come from the file. */
function reindentN(N: NLine[], O: string[], fileLines: string[], at: number, tier: number): string[] {
  if (tier !== 2 || O.length === 0) {
    return N.map((nl) => (nl.ctx ? fileLines[at + nl.oIdx!]! : nl.text));
  }
  const F = leadingWs(fileLines[at] ?? '');
  const P = leadingWs(O[0]!);
  return N.map((nl) => {
    if (nl.ctx) return fileLines[at + nl.oIdx!]!;
    const l = nl.text;
    if (l === '' || /^[ \t]+$/.test(l)) return l;
    if (l.startsWith(P)) return F + l.slice(P.length);
    return l;
  });
}

/** Replace O at `at` with N in a copy of the file lines; returns the new lines. */
function spliceN(fileLines: string[], O: string[], N: NLine[], at: number, tier: number): string[] {
  const mid = reindentN(N, O, fileLines, at, tier);
  const out = fileLines.slice();
  out.splice(at, O.length, ...mid);
  return out;
}

// ---------------------------------------------------------------------------
// Section 6: unified diffs.
// ---------------------------------------------------------------------------

type BKind = 'ctx' | 'old' | 'new' | 'bs';
interface BLine {
  kind: BKind;
  text: string;
}

function bodyLine(l: string): BLine | null {
  if (l === '') return { kind: 'ctx', text: '' };
  const c = l[0];
  if (c === ' ') return { kind: 'ctx', text: l.slice(1) };
  if (c === '-') return { kind: 'old', text: l.slice(1) };
  if (c === '+') return { kind: 'new', text: l.slice(1) };
  if (c === '\\') return { kind: 'bs', text: l.slice(1) };
  return null;
}

interface UHunk {
  A: number;
  body: BLine[];
  noEol: boolean;
}

interface USection {
  minus: string | null;
  plus: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  diffX: string | null;
  diffY: string | null;
  newFile: boolean;
  delFile: boolean;
  hunks: UHunk[];
}

function parseDiffPath(l: string): string {
  let p = l.slice(4).split('\t')[0]!.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function parseHunkHeader(l: string, i: number): number {
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
  if (!m) throw new Exit2(`error: parse ${i + 1}`);
  return parseInt(m[1]!, 10);
}

function parseHunkBody(lines: string[], start: number, A: number): { hunk: UHunk; next: number } {
  const body: BLine[] = [];
  let i = start;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    const b = bodyLine(l);
    if (b === null) break;
    body.push(b);
    i++;
  }
  while (body.length > 0) {
    const lastB = body[body.length - 1]!;
    if (lastB.kind === 'ctx' && lastB.text === '') body.pop();
    else break;
  }
  let noEol = false;
  for (let k = body.length - 1; k >= 0; k--) {
    if (body[k]!.kind === 'ctx' || body[k]!.kind === 'new') {
      noEol = body[k + 1] !== undefined && body[k + 1]!.kind === 'bs';
      break;
    }
  }
  return { hunk: { A, body, noEol }, next: i };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  const startSection = (): USection => {
    const s: USection = { minus: null, plus: null, renameFrom: null, renameTo: null, diffX: null, diffY: null, newFile: false, delFile: false, hunks: [] };
    sections.push(s);
    return s;
  };
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)\s*$/.exec(l);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      cur = startSection();
      cur.diffX = m[1]!;
      cur.diffY = m[2]!;
      i++;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && cur.hunks.length === 0) {
        cur.minus = parseDiffPath(l);
        cur.plus = parseDiffPath(lines[i + 1]!);
      } else {
        cur = startSection();
        cur.minus = parseDiffPath(l);
        cur.plus = parseDiffPath(lines[i + 1]!);
      }
      i += 2;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (l.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (l.startsWith('+++ ')) {
        cur.plus = parseDiffPath(l);
        i++;
        continue;
      }
      if (l.startsWith('rename from ')) {
        cur.renameFrom = l.slice(12).trim();
        i++;
        continue;
      }
      if (l.startsWith('rename to ')) {
        cur.renameTo = l.slice(10).trim();
        i++;
        continue;
      }
      if (l.startsWith('new file mode')) {
        cur.newFile = true;
        i++;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        cur.delFile = true;
        i++;
        continue;
      }
      if (l.startsWith('@@')) {
        const A = parseHunkHeader(l, i);
        const r = parseHunkBody(lines, i + 1, A);
        cur.hunks.push(r.hunk);
        i = r.next;
        continue;
      }
      i++;
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const A = parseHunkHeader(l, i);
      const r = parseHunkBody(lines, i + 1, A);
      cur.hunks.push(r.hunk);
      i = r.next;
      continue;
    }
    i++;
  }
  return sections.map((sec) => makeUnifiedEdit(sec, strict));
}

function hunkON(body: BLine[]): { O: string[]; N: NLine[] } {
  const O: string[] = [];
  const N: NLine[] = [];
  for (const b of body) {
    if (b.kind === 'ctx') {
      O.push(b.text);
      N.push({ text: b.text, ctx: true, oIdx: O.length - 1 });
    } else if (b.kind === 'old') {
      O.push(b.text);
    } else if (b.kind === 'new') {
      N.push({ text: b.text, ctx: false });
    }
  }
  return { O, N };
}

function applyUnifiedHunk(fl: FileLines, h: UHunk, d: number, strict: boolean, path: string): { fl: FileLines; delta: number } {
  const { O, N } = hunkON(h.body);
  const lines = fl.lines.slice();
  let final = fl.final;
  if (O.length === 0) {
    const at = Math.min(h.A + d, lines.length);
    const atEnd = at === lines.length;
    const ins = reindentN(N, O, lines, at, 0);
    lines.splice(at, 0, ...ins);
    if (atEnd) final = !h.noEol;
    return { fl: { lines, br: fl.br, final }, delta: N.length };
  }
  const found = findTier(lines, O, strict);
  if (!found) throw new Fail('no-match', path);
  const target = h.A - 1 + d;
  let at = found.occ[0]!;
  for (const o of found.occ) {
    if (Math.abs(o - target) < Math.abs(at - target)) at = o;
  }
  const runsToEnd = at + O.length === lines.length;
  const out = spliceN(lines, O, N, at, found.tier);
  if (runsToEnd) final = !h.noEol;
  return { fl: { lines: out, br: fl.br, final }, delta: N.length - O.length };
}

function makeUnifiedEdit(sec: USection, strict: boolean): Edit {
  const oldP = sec.minus ?? sec.renameFrom ?? sec.diffX ?? '';
  const newP = sec.plus ?? sec.renameTo ?? sec.diffY ?? '';
  const isCreate = oldP === '/dev/null' || sec.newFile;
  const isDelete = !isCreate && (newP === '/dev/null' || sec.delFile);
  const isMove = !isCreate && !isDelete && oldP !== newP;
  return (tree) => {
    if (isCreate) {
      if (!safe(newP)) throw new Fail('unsafe', newP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plusLines: string[] = [];
      for (const h of sec.hunks) for (const b of h.body) if (b.kind === 'new') plusLines.push(b.text);
      let noEol = false;
      for (const h of sec.hunks) {
        for (let k = h.body.length - 1; k >= 0; k--) {
          if (h.body[k]!.kind === 'new') {
            noEol = h.body[k + 1] !== undefined && h.body[k + 1]!.kind === 'bs';
            break;
          }
        }
      }
      const text = plusLines.length === 0 ? '' : plusLines.join('\n') + (noEol ? '' : '\n');
      tree.now.set(newP, text);
      return;
    }
    if (isDelete) {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (!safe(oldP)) throw new Fail('unsafe', oldP);
    if (isMove && !safe(newP)) throw new Fail('unsafe', newP);
    const cur = tree.get(oldP);
    if (cur === null) throw new Fail('missing', oldP);
    if (isMove && tree.get(newP) !== null) throw new Fail('exists', newP);
    let fl = splitFile(cur);
    let d = 0;
    for (const h of sec.hunks) {
      const r = applyUnifiedHunk(fl, h, d, strict, oldP);
      fl = r.fl;
      d += r.delta;
    }
    const text = joinFile(fl);
    if (isMove) {
      tree.now.set(oldP, null);
      tree.now.set(newP, text);
      tree.recordMove(oldP, newP);
    } else {
      tree.now.set(oldP, text);
    }
  };
}

// ---------------------------------------------------------------------------
// Section 7: SEARCH/REPLACE blocks.
// ---------------------------------------------------------------------------

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let searchFrom = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i;
    let eq = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') break;
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') break;
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    let path: string | null = null;
    for (let j = searchLine - 1; j >= searchFrom; j--) {
      const t = lines[j]!.trim();
      if (t === '') continue;
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine + 1}`);
    const oldLines = lines.slice(searchLine + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(makeSrEdit(path, oldLines, newLines, strict));
    prevPath = path;
    searchFrom = rep + 1;
    i = rep + 1;
  }
  return edits;
}

function makeSrEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    const cur = tree.get(path);
    if (oldLines.length === 0) {
      if (cur !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    if (cur === null) throw new Fail('missing', path);
    const fl = splitFile(cur);
    const found = findTier(fl.lines, oldLines, strict);
    if (!found) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const at = found.occ[0]!;
    const N: NLine[] = newLines.map((t) => ({ text: t, ctx: false }));
    const out = spliceN(fl.lines, oldLines, N, at, found.tier);
    tree.now.set(path, joinFile({ lines: out, br: fl.br, final: fl.final }));
  };
}

// ---------------------------------------------------------------------------
// Section 8: V4A patches.
// ---------------------------------------------------------------------------

interface VChunk {
  anchor: string | null;
  body: BLine[];
  eof: boolean;
}

const v4aSectionStart = (l: string): boolean =>
  l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    if (l.startsWith('*** Add File: ')) {
      const path = l.slice(14).trim();
      const content: string[] = [];
      let j = i + 1;
      while (j < last && !v4aSectionStart(lines[j]!)) {
        content.push(lines[j]!);
        j++;
      }
      while (content.length > 0 && blank(content[content.length - 1]!)) content.pop();
      for (let k = 0; k < content.length; k++) {
        const cl = content[k]!;
        if (!(cl.startsWith('+') || cl === '')) throw new Exit2(`error: parse ${i + 2 + k}`);
      }
      const fileLines = content.map((cl) => (cl === '' ? '' : cl.slice(1)));
      edits.push(makeV4aAddEdit(path, fileLines));
      i = j;
      continue;
    }
    if (l.startsWith('*** Delete File: ')) {
      const path = l.slice(17).trim();
      let j = i + 1;
      while (j < last && !v4aSectionStart(lines[j]!)) {
        if (!blank(lines[j]!)) throw new Exit2(`error: parse ${j + 1}`);
        j++;
      }
      edits.push(makeV4aDeleteEdit(path));
      i = j;
      continue;
    }
    if (l.startsWith('*** Update File: ')) {
      const path = l.slice(17).trim();
      let j = i + 1;
      while (j < last && blank(lines[j]!)) j++;
      let moveTo: string | null = null;
      if (j < last && lines[j]!.startsWith('*** Move to: ')) {
        moveTo = lines[j]!.slice(13).trim();
        j++;
      }
      const rawStart = j;
      const raw: string[] = [];
      while (j < last && !v4aSectionStart(lines[j]!)) {
        raw.push(lines[j]!);
        j++;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
      let k = 0;
      while (k < raw.length && blank(raw[k]!)) k++;
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      for (; k < raw.length; k++) {
        const cl = raw[k]!;
        const absLine = rawStart + k + 1;
        if (cl.startsWith('@@')) {
          cur = { anchor: cl.slice(2).trim(), body: [], eof: false };
          chunks.push(cur);
          continue;
        }
        if (cl === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${absLine}`);
          cur.eof = true;
          cur = null;
          continue;
        }
        const b = bodyLine(cl);
        if (b === null) throw new Exit2(`error: parse ${absLine}`);
        if (cur === null) {
          cur = { anchor: null, body: [], eof: false };
          chunks.push(cur);
        }
        cur.body.push(b);
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${i + 1}`);
      edits.push(makeV4aUpdateEdit(path, moveTo, chunks, strict));
      i = j;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

function makeV4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function makeV4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function findAnchor(fileLines: string[], anchor: string, cursor: number, strict: boolean): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let i = cursor; i < fileLines.length; i++) {
      if (normLine(fileLines[i]!, t) === normLine(anchor, t)) return i;
    }
  }
  return -1;
}

function makeV4aUpdateEdit(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let fl = splitFile(cur);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null && ch.anchor !== '') {
        const idx = findAnchor(fl.lines, ch.anchor, cursor, strict);
        if (idx < 0) throw new Fail('no-match', path);
        cursor = idx + 1;
      }
      const { O, N } = hunkON(ch.body);
      if (O.length === 0) {
        const at = ch.eof ? fl.lines.length : cursor;
        const ins = reindentN(N, O, fl.lines, at, 0);
        const lines = fl.lines.slice();
        lines.splice(at, 0, ...ins);
        fl = { lines, br: fl.br, final: fl.final };
        cursor = at + ins.length;
        continue;
      }
      const tiers = strict ? [0] : [0, 1, 2];
      let found: { tier: number; at: number } | null = null;
      for (const t of tiers) {
        const occ = occurrences(fl.lines, O, t).filter((pos) => pos >= cursor && (!ch.eof || pos + O.length === fl.lines.length));
        if (occ.length > 0) {
          found = { tier: t, at: occ[0]! };
          break;
        }
      }
      if (!found) throw new Fail('no-match', path);
      const out = spliceN(fl.lines, O, N, found.at, found.tier);
      fl = { lines: out, br: fl.br, final: fl.final };
      cursor = found.at + N.length;
    }
    const text = joinFile(fl);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, text);
      tree.recordMove(path, moveTo);
    } else {
      tree.now.set(path, text);
    }
  };
}

// ---------------------------------------------------------------------------
// Section 1, 2 and 10: invocation, output, exit codes, order and atomicity.
// ---------------------------------------------------------------------------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? srEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed: string[] = [];
  for (const p of [...tree.now.keys()]) {
    if (tree.original(p) !== tree.now.get(p)) changed.push(p);
  }
  const rows: { key: string; line: string }[] = [];
  const consumed = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    const wasOld = tree.original(oldP);
    const nowOld = tree.now.has(oldP) ? tree.now.get(oldP)! : wasOld;
    const wasNew = tree.original(newP);
    const nowNew = tree.now.has(newP) ? tree.now.get(newP)! : wasNew;
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      consumed.add(oldP);
      consumed.add(newP);
    }
  }
  for (const p of changed) {
    if (consumed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of changed) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
