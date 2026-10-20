/** Minimal S-expression reader/writer for KiCad files. */
export type SExpr = string | number | SList;
export interface SList extends Array<SExpr> {}
/** Wrapper to force a value to be written quoted. */
export class Q { constructor(public s: string) {} }

export function parseSExpr(src: string): SList {
  let i = 0;
  const n = src.length;
  const stack: SList[] = [[]];
  while (i < n) {
    const c = src[i];
    if (c === '(') { const l: SList = []; stack[stack.length - 1].push(l); stack.push(l); i++; }
    else if (c === ')') { stack.pop(); if (!stack.length) throw new Error('Unbalanced parenthesis at ' + i); i++; }
    else if (c === ' ' || c === '\n' || c === '\r' || c === '\t') i++;
    else if (c === '"') {
      let s = ''; i++;
      while (i < n && src[i] !== '"') {
        if (src[i] === '\\' && i + 1 < n) { const e = src[i + 1]; s += e === 'n' ? '\n' : e === 't' ? '\t' : e; i += 2; }
        else s += src[i++];
      }
      i++;
      // quoted strings are kept as strings and marked so numbers-in-quotes stay strings
      stack[stack.length - 1].push(new String(s) as unknown as string);
    } else {
      let j = i;
      while (j < n && !' \n\r\t()'.includes(src[j])) j++;
      const tok = src.slice(i, j);
      const num = Number(tok);
      stack[stack.length - 1].push(tok !== '' && /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(tok) && !Number.isNaN(num) ? num : tok);
      i = j;
    }
  }
  return stack[0];
}

export const head = (e: SExpr): string | undefined => (Array.isArray(e) && e.length ? String(e[0]) : undefined);
export const isList = (e: SExpr): e is SList => Array.isArray(e);
/** First child list with the given head. */
export function find(l: SList, name: string): SList | undefined { for (const e of l) if (isList(e) && String(e[0]) === name) return e; return undefined; }
export function findAll(l: SList, name: string): SList[] { return l.filter((e): e is SList => isList(e) && String(e[0]) === name); }
export const str = (e: SExpr | undefined) => (e === undefined ? undefined : String(e));
export const num = (e: SExpr | undefined, d = 0) => { if (e === undefined) return d; const v = Number(e instanceof String ? e.valueOf() : e); return Number.isFinite(v) ? v : d; };
/** Value of (name v) */
export const val = (l: SList, name: string) => find(l, name)?.[1];
export const xy = (l: SList | undefined) => ({ x: num(l?.[1]), y: num(l?.[2]) });
/** Flag present either as bare token or as (name yes) */
export function flag(l: SList, name: string): boolean {
  for (const e of l) {
    if (!(e instanceof String) && e === name) return true;
    if (isList(e) && String(e[0]) === name) return e.length < 2 || String(e[1]) === 'yes';
  }
  return false;
}

const fmtNum = (v: number) => { const r = Math.round(v * 1e6) / 1e6; return Object.is(r, -0) ? '0' : String(r); };
function atom(v: SExpr | Q | boolean): string {
  if (v instanceof Q) return '"' + v.s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"';
  if (typeof v === 'number') return fmtNum(v);
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  return String(v);
}

export type W = (string | number | Q | boolean | W | undefined | null)[];

/** Pretty-print: lists that only contain atoms or short lists stay on one line. */
export function writeSExpr(e: W, indent = 0): string {
  const items = e.filter(x => x !== undefined && x !== null) as (string | number | Q | boolean | W)[];
  const simple = items.every(x => !Array.isArray(x) || (x as W).every(y => !Array.isArray(y) || (y as W).every(z => !Array.isArray(z))));
  const parts = items.map(x => (Array.isArray(x) ? writeSExpr(x, indent + 1) : atom(x)));
  const one = '(' + parts.join(' ') + ')';
  if (simple && one.length < 160 && !one.includes('\n')) return one;
  const pad = '\t'.repeat(indent + 1);
  let out = '(' + parts[0];
  let i = 1;
  while (i < parts.length && !Array.isArray(items[i])) out += ' ' + parts[i++];
  for (; i < parts.length; i++) out += '\n' + pad + parts[i];
  return out + '\n' + '\t'.repeat(indent) + ')';
}
export const q = (s: string) => new Q(s);
