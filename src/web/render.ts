/** SVG preview renderer for the neutral model (footprints, symbols, boards). */
import type { Board, Footprint, Graphic, Pad, Pt, Symbol, SymbolUnit, Text } from '../core/model';
import { arcSweep, footprintBBox, graphicPts, rotDown, add, bboxOfPts } from '../core/geom';

export type LayerGroup = 'F.Cu' | 'B.Cu' | 'In.Cu' | 'F.SilkS' | 'B.SilkS' | 'F.Fab' | 'B.Fab' | 'Mask' | 'CrtYd' | 'Edge.Cuts' | 'Other';
export const LAYER_GROUPS: { id: LayerGroup; label: string; color: string }[] = [
  { id: 'F.Cu', label: 'Top copper', color: '#c83434' },
  { id: 'B.Cu', label: 'Bottom copper', color: '#4d7fc4' },
  { id: 'In.Cu', label: 'Inner copper', color: '#c2a536' },
  { id: 'F.SilkS', label: 'Top silk', color: '#f2eda1' },
  { id: 'B.SilkS', label: 'Bottom silk', color: '#e8b2a7' },
  { id: 'F.Fab', label: 'Top fab', color: '#afafaf' },
  { id: 'B.Fab', label: 'Bottom fab', color: '#585d84' },
  { id: 'Mask', label: 'Mask / paste', color: '#d864ff' },
  { id: 'CrtYd', label: 'Courtyard', color: '#ff26e2' },
  { id: 'Edge.Cuts', label: 'Board edge', color: '#d0d2cd' },
  { id: 'Other', label: 'Other', color: '#5d9ccc' },
];
export function layerGroup(l: string): LayerGroup {
  if (l === 'F.Cu' || l === 'B.Cu' || l === 'Edge.Cuts' || l === 'F.SilkS' || l === 'B.SilkS' || l === 'F.Fab' || l === 'B.Fab') return l;
  if (/^In\d+\.Cu$/.test(l)) return 'In.Cu';
  if (/Mask|Paste/.test(l)) return 'Mask';
  if (/CrtYd/.test(l)) return 'CrtYd';
  return 'Other';
}
const color = (g: LayerGroup) => LAYER_GROUPS.find(x => x.id === g)!.color;
const f = (v: number) => (Math.round(v * 1000) / 1000).toString();
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function arcD(s: Pt, m: Pt, e: Pt): string {
  const a = arcSweep(s, m, e);
  if (!a) return `M${f(s.x)} ${f(s.y)}L${f(e.x)} ${f(e.y)}`;
  return `M${f(s.x)} ${f(s.y)}A${f(a.radius)} ${f(a.radius)} 0 ${Math.abs(a.sweep) > 180 ? 1 : 0} ${a.sweep > 0 ? 1 : 0} ${f(e.x)} ${f(e.y)}`;
}

function textSvg(t: Text, fill: string, yUp = false, rotExtra = 0): string {
  if (t.hidden) return '';
  const anchor = t.justify === 'left' ? 'start' : t.justify === 'right' ? 'end' : 'middle';
  const rot = -(t.rotation + rotExtra);
  const x = t.at.x, y = yUp ? -t.at.y : t.at.y;
  const mirror = t.mirror ? ' scale(-1 1)' : '';
  const label = t.text.replace(/^\$\{REFERENCE\}$/, 'REF**').replace(/^\$\{VALUE\}$/, 'VAL**');
  // keep text upright-ish like EDA tools do
  const r = ((rot % 360) + 360) % 360;
  const flip = r > 90 && r <= 270 ? 180 : 0;
  return `<text x="0" y="0" transform="translate(${f(x)} ${f(y)}) rotate(${f(rot + flip)})${mirror}" font-size="${f(t.size)}" text-anchor="${flip ? (anchor === 'start' ? 'end' : anchor === 'end' ? 'start' : 'middle') : anchor}" dominant-baseline="central" fill="${fill}" class="t">${esc(label)}</text>`;
}

export function graphicSvg(g: Graphic, stroke: string, yUp = false, opts: { fillColor?: string; textRot?: number } = {}): string {
  const P = (p: Pt) => (yUp ? { x: p.x, y: -p.y } : p);
  const w = Math.max(g.width, yUp ? 0.15 : 0.05);
  const fill = g.fill ? (opts.fillColor ?? stroke) : 'none';
  switch (g.type) {
    case 'line': { const a = P(g.a), b = P(g.b); return `<line x1="${f(a.x)}" y1="${f(a.y)}" x2="${f(b.x)}" y2="${f(b.y)}" stroke="${stroke}" stroke-width="${f(w)}" stroke-linecap="round"/>`; }
    case 'arc': return `<path d="${arcD(P(g.start), P(g.mid), P(g.end))}" fill="none" stroke="${stroke}" stroke-width="${f(w)}" stroke-linecap="round"/>`;
    case 'circle': { const c = P(g.center); return `<circle cx="${f(c.x)}" cy="${f(c.y)}" r="${f(g.radius)}" fill="${fill}" stroke="${stroke}" stroke-width="${f(g.fill && !g.width ? 0 : w)}"/>`; }
    case 'rect': { const a = P(g.a), b = P(g.b); return `<rect x="${f(Math.min(a.x, b.x))}" y="${f(Math.min(a.y, b.y))}" width="${f(Math.abs(b.x - a.x))}" height="${f(Math.abs(b.y - a.y))}" fill="${fill}" stroke="${stroke}" stroke-width="${f(g.fill && !g.width ? 0 : w)}"/>`; }
    case 'poly': {
      const pts = g.pts.map(P).map(p => `${f(p.x)},${f(p.y)}`).join(' ');
      return g.closed ? `<polygon points="${pts}" fill="${fill}" stroke="${stroke}" stroke-width="${f(g.fill && !g.width ? 0 : w)}" stroke-linejoin="round"/>` : `<polyline points="${pts}" fill="none" stroke="${stroke}" stroke-width="${f(w)}" stroke-linecap="round" stroke-linejoin="round"/>`;
    }
    case 'text': return textSvg(g, stroke, yUp, opts.textRot);
  }
}

function padSvg(p: Pad, show: (g: LayerGroup) => boolean, label: boolean): string {
  const cu: LayerGroup = p.kind === 'smd' ? (p.side === 'B' ? 'B.Cu' : 'F.Cu') : 'F.Cu';
  const visible = p.kind === 'smd' ? show(cu) : show('F.Cu') || show('B.Cu');
  if (!visible && p.kind !== 'npth') return '';
  const fill = p.kind === 'npth' ? 'none' : p.kind === 'thru' ? '#c2a536' : color(cu);
  const hw = p.w / 2, hh = p.h / 2;
  let shape = '';
  const tr = `translate(${f(p.at.x)} ${f(p.at.y)}) rotate(${f(-p.rotation)})`;
  if (p.shape === 'circle') shape = `<circle r="${f(Math.min(hw, hh))}"/>`;
  else if (p.shape === 'custom' && p.poly?.length) shape = `<polygon points="${p.poly.map(q => `${f(q.x)},${f(q.y)}`).join(' ')}"/>`;
  else if (p.shape === 'octagon') { const k = 0.4142; shape = `<polygon points="${[[-hw, -hh * k], [-hw * k, -hh], [hw * k, -hh], [hw, -hh * k], [hw, hh * k], [hw * k, hh], [-hw * k, hh], [-hw, hh * k]].map(v => v.map(f).join(',')).join(' ')}"/>`; }
  else {
    const r = p.shape === 'oval' ? Math.min(hw, hh) : p.shape === 'roundrect' ? Math.min(hw, hh) * 2 * (p.roundRatio ?? 0.25) : 0;
    shape = `<rect x="${f(-hw)}" y="${f(-hh)}" width="${f(p.w)}" height="${f(p.h)}" rx="${f(r)}"/>`;
  }
  let drill = '';
  if (p.drill) {
    const dw = p.drill.w / 2, dh = p.drill.h / 2;
    drill = Math.abs(dw - dh) < 1e-6 ? `<circle r="${f(dw)}" class="drill"/>` : `<rect x="${f(-dw)}" y="${f(-dh)}" width="${f(2 * dw)}" height="${f(2 * dh)}" rx="${f(Math.min(dw, dh))}" class="drill"/>`;
  }
  const num = label && p.number && p.kind !== 'npth' ? `<text class="padnum" font-size="${f(Math.max(0.15, Math.min(p.w, p.h, 2) * 0.45))}" text-anchor="middle" dominant-baseline="central" transform="rotate(${f(p.rotation)})">${esc(p.number)}</text>` : '';
  return `<g transform="${tr}" fill="${fill}" ${p.kind === 'npth' ? 'stroke="#888" stroke-width="0.05"' : ''} opacity="${p.side === 'B' && p.kind === 'smd' ? 0.85 : 0.92}">${p.kind === 'npth' ? '' : shape}${drill}${num}</g>`;
}

const ORDER: LayerGroup[] = ['B.Fab', 'B.SilkS', 'B.Cu', 'In.Cu', 'F.Cu', 'Mask', 'F.Fab', 'CrtYd', 'Edge.Cuts', 'Other', 'F.SilkS'];

function fpContent(fp: Footprint, show: (g: LayerGroup) => boolean, padLabels: boolean, texts: Text[] = [], textRot = 0): string {
  const byLayer = new Map<LayerGroup, string[]>();
  for (const g of [...fp.graphics, ...texts]) {
    const lg = layerGroup(g.layer);
    if (!show(lg)) continue;
    const arr = byLayer.get(lg) ?? []; arr.push(graphicSvg(g, color(lg), false, { textRot })); byLayer.set(lg, arr);
  }
  let out = '';
  for (const lg of ORDER) {
    if (lg === 'F.Cu') out += fp.pads.filter(p => p.kind !== 'smd' || p.side === 'B').map(p => padSvg(p, show, padLabels)).join('') + fp.pads.filter(p => p.kind === 'smd' && p.side === 'F').map(p => padSvg(p, show, padLabels)).join('');
    out += (byLayer.get(lg) ?? []).join('');
  }
  for (const h of fp.holes ?? []) out += `<circle cx="${f(h.at.x)}" cy="${f(h.at.y)}" r="${f(h.d / 2)}" class="drill" stroke="#888" stroke-width="0.05"/>`;
  return out;
}

export interface View { svg: string; box: { x: number; y: number; w: number; h: number } }

function pad(box: { x0: number; y0: number; x1: number; y1: number }, m: number) {
  const w = Math.max(box.x1 - box.x0, 1), h = Math.max(box.y1 - box.y0, 1);
  const mm = Math.max(w, h) * m;
  return { x: box.x0 - mm, y: box.y0 - mm, w: w + 2 * mm, h: h + 2 * mm };
}

export function renderFootprint(fp: Footprint, show: (g: LayerGroup) => boolean): View {
  const bb = footprintBBox(fp);
  const gpts = fp.graphics.flatMap(g => g.type === 'text' ? [{ x: g.at.x, y: g.at.y - g.size }, { x: g.at.x, y: g.at.y + g.size }] : graphicPts(g));
  const all = bboxOfPts([{ x: bb.x0, y: bb.y0 }, { x: bb.x1, y: bb.y1 }, ...gpts]);
  return { svg: `<g class="origin"><path d="M-0.6 0H0.6M0 -0.6V0.6" stroke="#888" stroke-width="0.04"/></g>${fpContent(fp, show, true)}`, box: pad(all, 0.22) };
}

const PIN = '#a02b2b', BODY = '#8f1d1d', BODYFILL = 'var(--sym-fill)', SYMTEXT = 'var(--sym-text)';
export function renderSymbol(s: Symbol, unit = 0): View {
  const u: SymbolUnit = s.units[unit] ?? s.units[0];
  let out = '';
  for (const g of u.graphics) out += graphicSvg(g, g.type === 'text' ? SYMTEXT : BODY, true, { fillColor: BODYFILL });
  const pts: Pt[] = u.graphics.flatMap(graphicPts);
  for (const p of u.pins) {
    const a = { x: p.at.x, y: -p.at.y };
    // angle is CCW in the symbol's Y-up frame; on screen (Y-down) the direction is (cos, -sin)
    const dirUp = { x: Math.cos((p.angle * Math.PI) / 180), y: -Math.sin((p.angle * Math.PI) / 180) };
    const b = add(a, { x: dirUp.x * p.length, y: dirUp.y * p.length });
    pts.push({ x: a.x, y: -a.y }, { x: b.x, y: -b.y });
    if (p.hidden) { out += `<circle cx="${f(a.x)}" cy="${f(a.y)}" r="0.2" fill="none" stroke="${PIN}" stroke-width="0.08" opacity="0.5"/>`; continue; }
    out += `<line x1="${f(a.x)}" y1="${f(a.y)}" x2="${f(b.x)}" y2="${f(b.y)}" stroke="${PIN}" stroke-width="0.15"/>`;
    if (p.shape === 'inverted' || p.shape === 'inverted_clock') out += `<circle cx="${f(b.x - dirUp.x * 0.4)}" cy="${f(b.y - dirUp.y * 0.4)}" r="0.4" fill="none" stroke="${PIN}" stroke-width="0.15"/>`;
    out += `<circle cx="${f(a.x)}" cy="${f(a.y)}" r="0.12" fill="${PIN}"/>`;
    const horiz = Math.abs(dirUp.x) > 0.5;
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const rot = horiz ? 0 : -90;
    // number above the pin line, name inside the body
    if (p.number) out += `<text transform="translate(${f(mid.x + (horiz ? 0 : -0.35))} ${f(mid.y + (horiz ? -0.35 : 0))}) rotate(${rot})" font-size="1" text-anchor="middle" fill="${PIN}" class="t">${esc(p.number)}</text>`;
    if (p.name && p.name !== '~') {
      const off = 0.6;
      const at = { x: b.x + dirUp.x * off, y: b.y + dirUp.y * off };
      const anchor = horiz ? (dirUp.x > 0 ? 'start' : 'end') : (dirUp.y < 0 ? 'start' : 'end');
      out += `<text transform="translate(${f(at.x)} ${f(at.y)}) rotate(${rot})" font-size="1.1" text-anchor="${anchor}" dominant-baseline="central" fill="${SYMTEXT}" class="t">${esc(p.name.replace(/~\{([^}]*)\}/g, '$1'))}</text>`;
    }
  }
  if (!pts.length) pts.push({ x: -2, y: -2 }, { x: 2, y: 2 });
  const bb = bboxOfPts(pts.map(p => ({ x: p.x, y: -p.y })));
  // name labels inside the box can extend; give a generous margin
  return { svg: out, box: pad(bb, 0.12) };
}

export function renderBoard(b: Board, show: (g: LayerGroup) => boolean): View {
  const layers = new Map<LayerGroup, string[]>();
  const add2 = (lg: LayerGroup, s: string) => { const a = layers.get(lg) ?? []; a.push(s); layers.set(lg, a); };
  for (const z of b.zones) {
    const lg = layerGroup(z.layer);
    if (!show(lg) || z.outline.length < 3) continue;
    add2(lg, `<polygon points="${z.outline.map(p => `${f(p.x)},${f(p.y)}`).join(' ')}" fill="${z.keepout ? 'none' : color(lg)}" fill-opacity="0.18" stroke="${color(lg)}" stroke-width="0.15" ${z.keepout ? 'stroke-dasharray="0.6 0.4"' : ''}/>`);
  }
  for (const t of b.tracks) {
    const lg = layerGroup(t.layer);
    if (!show(lg)) continue;
    add2(lg, t.mid ? `<path d="${arcD(t.a, t.mid, t.b)}" fill="none" stroke="${color(lg)}" stroke-width="${f(t.width)}" stroke-linecap="round"/>` : `<line x1="${f(t.a.x)}" y1="${f(t.a.y)}" x2="${f(t.b.x)}" y2="${f(t.b.y)}" stroke="${color(lg)}" stroke-width="${f(t.width)}" stroke-linecap="round"/>`);
  }
  for (const g of b.graphics) { const lg = layerGroup(g.layer); if (show(lg)) add2(lg, graphicSvg(g, color(lg))); }
  let out = '';
  for (const lg of ORDER) out += (layers.get(lg) ?? []).join('');
  for (const fp of b.footprints) {
    out += `<g transform="translate(${f(fp.at.x)} ${f(fp.at.y)}) rotate(${f(-fp.rotation)})">${fpContent(fp.footprint, show, false, fp.texts ?? [], fp.rotation)}</g>`;
  }
  if (show('F.Cu') || show('B.Cu')) for (const v of b.vias) out += `<circle cx="${f(v.at.x)}" cy="${f(v.at.y)}" r="${f(v.size / 2)}" fill="#c2a536"/><circle cx="${f(v.at.x)}" cy="${f(v.at.y)}" r="${f(v.drill / 2)}" class="drill"/>`;
  for (const h of b.holes) out += `<circle cx="${f(h.at.x)}" cy="${f(h.at.y)}" r="${f(h.d / 2)}" class="drill" stroke="#888" stroke-width="0.05"/>`;
  const edge = b.graphics.filter(g => g.layer === 'Edge.Cuts').flatMap(graphicPts);
  const pts = edge.length ? edge : [...b.footprints.map(p => p.at), ...b.tracks.flatMap(t => [t.a, t.b])];
  if (!pts.length) pts.push({ x: 0, y: 0 }, { x: 10, y: 10 });
  return { svg: out, box: pad(bboxOfPts(pts), 0.04) };
}

/** Footprints placed on a board, for the board's "footprint" view. */
export function footprintWorld(fp: { at: Pt; rotation: number }, p: Pt) { return add(fp.at, rotDown(p, fp.rotation)); }
