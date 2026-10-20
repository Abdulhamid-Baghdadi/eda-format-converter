import type { Board } from '../src/core/model';
import { placeDown } from '../src/core/kicad/read';

/** Geometric comparison of two boards: pads (world position/size/net), tracks, vias. Returns human-readable problems. */
export function boardDiff(a: Board, b: Board, opts: { tol?: number; checkNets?: boolean; checkSizes?: boolean } = {}) {
  const tol = opts.tol ?? 0.01;
  const key = (x: number, y: number) => `${Math.round(x / tol)},${Math.round(y / tol)}`;
  const padMap = (bd: Board) => {
    const m = new Map<string, { w: number; h: number; net?: string; ref: string; n: string }[]>();
    for (const f of bd.footprints) for (const p of f.footprint.pads) {
      const w = placeDown(f, p.at);
      const k = key(w.x, w.y) + '#' + (p.number || 'MP').replace(/_\d+$/, '').replace(/^MP\d*$/, 'MP');
      const swap = Math.round(((((p.rotation + f.rotation) % 180) + 180) % 180) / 90) === 1;
      m.set(k, [...(m.get(k) ?? []), { w: swap ? p.h : p.w, h: swap ? p.w : p.h, net: p.net, ref: f.ref, n: p.number }]);
    }
    // board-level holes count as unnamed pads (KiCad stores them as one-pad footprints)
    for (const h of bd.holes) { const k = key(h.at.x, h.at.y) + '#MP'; m.set(k, [...(m.get(k) ?? []), { w: h.d, h: h.d, ref: 'hole', n: '' }]); }
    return m;
  };
  const problems: string[] = [];
  const pa = padMap(a), pb = padMap(b);
  const near = (m: typeof pb, k: string) => { if (m.has(k)) return m.get(k); const [xy, num] = k.split('#'); const [x, y] = xy.split(',').map(Number); for (const dx of [-1, 0, 1]) for (const dy of [-1, 0, 1]) { const v = m.get(`${x + dx},${y + dy}#${num}`); if (v) return v; } return undefined; };
  for (const [k, v] of pa) {
    const o = near(pb, k);
    if (!o) { problems.push(`pad ${v[0].ref}.${v[0].n} at ${k} missing`); continue; }
    if (opts.checkSizes !== false && !v.some(p => o.some(q => Math.abs(p.w - q.w) < 0.02 && Math.abs(p.h - q.h) < 0.02))) problems.push(`pad ${v[0].ref}.${v[0].n} size ${v[0].w}x${v[0].h} vs ${o[0].w}x${o[0].h}`);
    if (opts.checkNets !== false && !v.some(p => o.some(q => (p.net ?? '').replace(/^\//, '') === (q.net ?? '').replace(/^\//, '')))) problems.push(`pad ${v[0].ref}.${v[0].n} net ${v[0].net} vs ${o[0].net}`);
  }
  for (const [k, v] of pb) if (!near(pa, k)) problems.push(`extra pad ${v[0].ref}.${v[0].n} at ${k}`);
  // tracks / vias: tolerant matching (endpoints within tol)
  const near2 = (p: { x: number; y: number }, q: { x: number; y: number }) => Math.abs(p.x - q.x) <= tol && Math.abs(p.y - q.y) <= tol;
  const grid = new Map<string, Board['tracks']>();
  const cell = (p: { x: number; y: number }) => `${Math.floor(p.x)},${Math.floor(p.y)}`;
  for (const t of b.tracks) for (const p of [t.a, t.b]) { const k = cell(p); grid.set(k, [...(grid.get(k) ?? []), t]); }
  const cands = (p: { x: number; y: number }) => { const out: Board['tracks'] = []; for (const dx of [-1, 0, 1]) for (const dy of [-1, 0, 1]) out.push(...(grid.get(`${Math.floor(p.x) + dx},${Math.floor(p.y) + dy}`) ?? [])); return out; };
  let tm = 0;
  for (const t of a.tracks) if (!cands(t.a).some(u => u.layer === t.layer && ((near2(u.a, t.a) && near2(u.b, t.b)) || (near2(u.a, t.b) && near2(u.b, t.a))))) tm++;
  if (tm) problems.push(`${tm} of ${a.tracks.length} tracks not matched`);
  let vm = 0;
  for (const v of a.vias) if (!b.vias.some(w => near2(w.at, v.at))) vm++;
  if (vm) problems.push(`${vm} of ${a.vias.length} vias not matched`);
  return { problems, pads: pa.size, tracks: a.tracks.length, vias: a.vias.length };
}
