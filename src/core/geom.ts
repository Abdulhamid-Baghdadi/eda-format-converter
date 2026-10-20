import type { Pt, Graphic, Footprint, Pad, Text } from './model';

export const MIL = 0.0254;
export const deg = (r: number) => (r * 180) / Math.PI;
export const rad = (d: number) => (d * Math.PI) / 180;
export const round = (v: number, d = 6) => { const f = 10 ** d; const r = Math.round(v * f) / f; return Object.is(r, -0) ? 0 : r; };
export const normAngle = (a: number) => { a = a % 360; if (a < 0) a += 360; return round(a, 4) === 360 ? 0 : round(a, 4); };

/** Rotate CCW *as seen on screen* in a Y-down frame. */
export function rotDown(p: Pt, angle: number): Pt {
  const r = rad(angle), c = Math.cos(r), s = Math.sin(r);
  return { x: p.x * c + p.y * s, y: -p.x * s + p.y * c };
}
/** Rotate CCW in a Y-up frame. */
export function rotUp(p: Pt, angle: number): Pt {
  const r = rad(angle), c = Math.cos(r), s = Math.sin(r);
  return { x: p.x * c - p.y * s, y: p.x * s + p.y * c };
}
export const add = (a: Pt, b: Pt): Pt => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Pt, b: Pt): Pt => ({ x: a.x - b.x, y: a.y - b.y });
export const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

/** Arc defined by centre, start point and sweep angle (degrees, CCW positive in the *math* sense of the given frame). */
export function arcFromCenter(c: Pt, start: Pt, sweep: number, yUp: boolean): { start: Pt; mid: Pt; end: Pt } {
  const rot = yUp ? rotUp : (p: Pt, a: number) => rotDown(p, a);
  const v = sub(start, c);
  return { start, mid: add(c, rot(v, sweep / 2)), end: add(c, rot(v, sweep)) };
}

/** Circle through three points. */
export function circumcenter(a: Pt, b: Pt, c: Pt): Pt | null {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  if (Math.abs(d) < 1e-12) return null;
  const a2 = a.x * a.x + a.y * a.y, b2 = b.x * b.x + b.y * b.y, c2 = c.x * c.x + c.y * c.y;
  return { x: (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d, y: (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d };
}

/** Signed sweep (degrees, CCW positive in a math/Y-up sense) of the arc start->mid->end. */
export function arcSweep(start: Pt, mid: Pt, end: Pt): { center: Pt; radius: number; sweep: number } | null {
  const c = circumcenter(start, mid, end);
  if (!c) return null;
  const ang = (p: Pt) => Math.atan2(p.y - c.y, p.x - c.x);
  const a0 = ang(start), a1 = ang(mid), a2 = ang(end);
  const norm = (x: number) => { while (x < 0) x += 2 * Math.PI; while (x >= 2 * Math.PI) x -= 2 * Math.PI; return x; };
  const toMid = norm(a1 - a0), toEnd = norm(a2 - a0);
  const sweep = toMid < toEnd ? toEnd : toEnd - 2 * Math.PI;
  return { center: c, radius: dist(c, start), sweep: deg(sweep) };
}

/** Mid point of an arc given by endpoints and SVG-style flags (used by EasyEDA paths). */
export function svgArcMid(p0: Pt, p1: Pt, r: number, large: boolean, sweepFlag: boolean): Pt {
  const mx = (p0.x + p1.x) / 2, my = (p0.y + p1.y) / 2;
  const dx = p1.x - p0.x, dy = p1.y - p0.y, d = Math.hypot(dx, dy);
  if (d === 0) return p0;
  r = Math.max(r, d / 2);
  const h = Math.sqrt(Math.max(0, r * r - (d / 2) ** 2));
  // unit normal
  const nx = -dy / d, ny = dx / d;
  const sign = large === sweepFlag ? -1 : 1;
  const c = { x: mx + sign * h * nx, y: my + sign * h * ny };
  // mid of arc: from centre, direction to chord-midpoint (or opposite if large)
  const vx0 = mx - c.x, vy0 = my - c.y, vl0 = Math.hypot(vx0, vy0);
  if (vl0 < 1e-9 * Math.max(1, r)) {
    // half circle: the side follows the sweep direction (sweep=1 is clockwise on a Y-down screen)
    const s = sweepFlag ? -1 : 1;
    return { x: c.x + s * r * nx, y: c.y + s * r * ny };
  }
  const vx = vx0, vy = vy0, vl = vl0;
  const k = (large ? -1 : 1) * r / vl;
  return { x: c.x + vx * k, y: c.y + vy * k };
}

export function mapPt(g: Graphic, f: (p: Pt) => Pt): Graphic {
  switch (g.type) {
    case 'line': return { ...g, a: f(g.a), b: f(g.b) };
    case 'arc': return { ...g, start: f(g.start), mid: f(g.mid), end: f(g.end) };
    case 'circle': return { ...g, center: f(g.center) };
    case 'rect': return { ...g, a: f(g.a), b: f(g.b) };
    case 'poly': return { ...g, pts: g.pts.map(f) };
    case 'text': return { ...g, at: f(g.at) };
  }
}

/** Rect -> closed polygon (needed when a rect is rotated by a non-multiple of 90). */
export function rectToPoly(a: Pt, b: Pt): Pt[] { return [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }]; }

export function bboxOfPts(pts: Pt[]) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) { if (p.x < x0) x0 = p.x; if (p.y < y0) y0 = p.y; if (p.x > x1) x1 = p.x; if (p.y > y1) y1 = p.y; }
  return { x0, y0, x1, y1 };
}

export function graphicPts(g: Graphic): Pt[] {
  switch (g.type) {
    case 'line': return [g.a, g.b];
    case 'arc': return [g.start, g.mid, g.end];
    case 'circle': return [{ x: g.center.x - g.radius, y: g.center.y - g.radius }, { x: g.center.x + g.radius, y: g.center.y + g.radius }];
    case 'rect': return [g.a, g.b];
    case 'poly': return g.pts;
    case 'text': return [g.at];
  }
}

export function padPts(p: Pad): Pt[] {
  const hw = p.w / 2, hh = p.h / 2;
  return [{ x: -hw, y: -hh }, { x: hw, y: hh }, { x: -hw, y: hh }, { x: hw, y: -hh }].map(q => add(p.at, rotDown(q, p.rotation)));
}

export function footprintBBox(fp: Footprint) {
  const pts: Pt[] = [];
  for (const p of fp.pads) pts.push(...padPts(p));
  for (const g of fp.graphics) if (g.type !== 'text') pts.push(...graphicPts(g));
  if (!pts.length) return { x0: -1, y0: -1, x1: 1, y1: 1 };
  return bboxOfPts(pts);
}

export const flipLayer = (l: string) => l.startsWith('F.') ? 'B.' + l.slice(2) : l.startsWith('B.') ? 'F.' + l.slice(2) : l;

/** Mirror a footprint left/right (x -> -x) and swap F/B layers. Used for bottom-side placement. */
export function mirrorFootprintX(fp: Footprint): Footprint {
  const f = (p: Pt) => ({ x: -p.x, y: p.y });
  return {
    ...fp,
    pads: fp.pads.map(p => ({ ...p, at: f(p.at), rotation: normAngle(180 - p.rotation), side: p.side === 'F' ? 'B' : 'F', poly: p.poly?.map(q => ({ x: -q.x, y: q.y })) })),
    graphics: fp.graphics.map(g => { const m = mapPt(g, f); m.layer = flipLayer(g.layer); if (m.type === 'text') { m.mirror = !m.mirror; m.rotation = normAngle(-m.rotation); } return m; }),
    holes: fp.holes?.map(h => ({ ...h, at: f(h.at) })),
  };
}

export function textBase(t: Partial<Text> & { at: Pt; text: string; layer: string }): Text {
  return { type: 'text', size: 1, rotation: 0, width: 0.15, ...t } as Text;
}

export function uniqueName(base: string, used: Set<string>): string {
  let n = base, i = 2;
  while (used.has(n)) n = `${base}_${i++}`;
  used.add(n);
  return n;
}
