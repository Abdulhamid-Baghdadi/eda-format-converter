import type { Footprint, Symbol } from '../src/core/model';

const k = (x: number, y: number, tol: number) => `${Math.round(x / tol)},${Math.round(y / tol)}`;
/** Footprint geometry check: same pads (number, centre, size incl. rotation), same drill. */
export function footprintDiff(a: Footprint, b: Footprint, opts: { sizes?: boolean } = {}): string[] {
  const out: string[] = [];
  const norm = (n: string) => (n || 'MP').replace(/_\d+$/, '').replace(/^MP\d*$/, 'MP');
  const m = new Map<string, { w: number; h: number }[]>();
  const ext = (p: Footprint['pads'][0]) => { const q = ((Math.round(p.rotation / 90) % 2) + 2) % 2 === 1; return q ? { w: p.h, h: p.w } : { w: p.w, h: p.h }; };
  for (const p of b.pads) { const key = k(p.at.x, p.at.y, 0.01) + '#' + norm(p.number); m.set(key, [...(m.get(key) ?? []), ext(p)]); }
  for (const p of a.pads) {
    const key = k(p.at.x, p.at.y, 0.01) + '#' + norm(p.number);
    const o = m.get(key) ?? (() => { const [xy] = key.split('#'); const [x, y] = xy.split(',').map(Number); for (const dx of [-1, 0, 1]) for (const dy of [-1, 0, 1]) { const v = m.get(`${x + dx},${y + dy}#${norm(p.number)}`); if (v) return v; } return undefined; })();
    if (!o) { out.push(`${a.name}: pad ${p.number} at ${p.at.x},${p.at.y} missing`); continue; }
    const e = ext(p);
    if (opts.sizes !== false && !o.some(q => Math.abs(q.w - e.w) < 0.02 && Math.abs(q.h - e.h) < 0.02)) out.push(`${a.name}: pad ${p.number} size ${e.w}x${e.h} vs ${o[0].w}x${o[0].h}`);
  }
  if (a.pads.length + (a.holes?.length ?? 0) !== b.pads.length + (b.holes?.length ?? 0)) out.push(`${a.name}: ${a.pads.length + (a.holes?.length ?? 0)} pads vs ${b.pads.length + (b.holes?.length ?? 0)}`);
  return out;
}

/** Symbol check: same pins (number, connection point, direction) per unit. */
export function symbolDiff(a: Symbol, b: Symbol): string[] {
  const out: string[] = [];
  const pins = (s: Symbol) => new Set(s.units.flatMap((u, i) => u.pins.map(p => `${i}|${p.number}|${k(p.at.x, p.at.y, 0.01)}|${Math.round(p.angle) % 360}`)));
  const pa = pins(a), pb = pins(b);
  for (const p of pa) if (!pb.has(p)) out.push(`${a.name}: pin ${p} missing`);
  if (pa.size !== pb.size) out.push(`${a.name}: ${pa.size} pins vs ${pb.size}`);
  return out;
}
