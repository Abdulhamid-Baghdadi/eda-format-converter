/**
 * EasyEDA Standard ("classic") documents: the JSON you get from File ▸ EasyEDA Source / the component API.
 * Shapes are '~'-separated strings; units are 10 mil (0.254 mm), Y points down.
 * Written from scratch from observing the format — no code from easyeda2kicad (AGPL) is used.
 */
import type { Board, Footprint, Graphic, Library, Pad, PadShape, Pin, PinType, Pt, Symbol, Text, PlacedFootprint, Model3D } from '../model';
import { svgArcMid, normAngle, rotDown, sub, add, round } from '../geom';
import { Report } from '../report';

export const U = 0.254; // 10 mil
const n = (s: string | undefined, d = 0) => { const v = parseFloat(s ?? ''); return Number.isFinite(v) ? v : d; };

export const EE_LAYERS: Record<string, string> = {
  '1': 'F.Cu', '2': 'B.Cu', '3': 'F.SilkS', '4': 'B.SilkS', '5': 'F.Paste', '6': 'B.Paste', '7': 'F.Mask', '8': 'B.Mask',
  '10': 'Edge.Cuts', '12': 'Dwgs.User', '13': 'F.Fab', '14': 'B.Fab', '15': 'Dwgs.User', '99': 'F.Fab', '100': 'F.Fab', '101': 'F.Fab',
};
export function eeLayer(id: string): string | null {
  if (EE_LAYERS[id]) return EE_LAYERS[id];
  const l = +id;
  if (l >= 21 && l <= 52) return `In${l - 20}.Cu`;
  return null; // 9 ratlines, 11 multi-layer (pads only), 19 3D model ...
}

/** Parse an SVG-ish path made of M/L/A/Z commands into polyline points (arcs get their mid point). */
export function parsePath(d: string): { pts: Pt[]; closed: boolean; arcs: { start: Pt; mid: Pt; end: Pt }[] } {
  const toks = d.replace(/([MLAZHVmlazhv])/g, ' $1 ').replace(/,/g, ' ').trim().split(/\s+/);
  const pts: Pt[] = []; const arcs: { start: Pt; mid: Pt; end: Pt }[] = [];
  let i = 0, cmd = 'M', closed = false;
  let cur: Pt = { x: 0, y: 0 };
  while (i < toks.length) {
    if (/^[MLAZHVmlazhv]$/.test(toks[i])) { cmd = toks[i++]; if (cmd.toUpperCase() === 'Z') { closed = true; continue; } }
    if (i >= toks.length) break;
    switch (cmd.toUpperCase()) {
      case 'M': case 'L': cur = { x: +toks[i], y: +toks[i + 1] }; pts.push(cur); i += 2; break;
      case 'H': cur = { x: cmd === 'h' ? cur.x + +toks[i] : +toks[i], y: cur.y }; pts.push(cur); i += 1; break;
      case 'V': cur = { x: cur.x, y: cmd === 'v' ? cur.y + +toks[i] : +toks[i] }; pts.push(cur); i += 1; break;
      case 'A': {
        const rx = +toks[i], large = toks[i + 3] === '1', sweep = toks[i + 4] === '1';
        const end = { x: +toks[i + 5], y: +toks[i + 6] };
        const mid = svgArcMid(cur, end, rx, large, sweep);
        arcs.push({ start: cur, mid, end });
        pts.push(mid, end); cur = end; i += 7; break;
      }
      default: i++;
    }
  }
  return { pts, closed, arcs };
}

// ---------------------------------------------------------------- footprints

interface FpCtx { ox: number; oy: number; r: Report }
const P = (c: FpCtx, x: string | number, y: string | number): Pt => ({ x: round((+x - c.ox) * U, 5), y: round((+y - c.oy) * U, 5) });

const PAD_SHAPES: Record<string, PadShape> = { ELLIPSE: 'circle', RECT: 'rect', OVAL: 'oval', POLYGON: 'custom' };

function readPad(f: string[], c: FpCtx): Pad {
  const shape = PAD_SHAPES[f[1]] ?? 'rect';
  const layer = f[6];
  const holeR = n(f[9]) * U;
  const at = P(c, f[2], f[3]);
  const rot = normAngle(n(f[11]));
  const w = n(f[4]) * U, h = n(f[5]) * U;
  const pad: Pad = {
    number: f[8] ?? '', kind: layer === '11' ? (f[15] === 'N' ? 'npth' : 'thru') : 'smd', shape: shape === 'circle' && Math.abs(w - h) > 1e-6 ? 'oval' : shape,
    at, rotation: rot, w, h, side: layer === '2' ? 'B' : 'F', net: f[7] || undefined,
  };
  if (pad.kind !== 'smd' && holeR > 0) {
    const slot = n(f[13]) * U;
    if (slot > 0) {
      // slot runs along the pad's long axis
      pad.drill = w >= h ? { w: Math.max(slot, 2 * holeR), h: 2 * holeR } : { w: 2 * holeR, h: Math.max(slot, 2 * holeR) };
    } else pad.drill = { w: 2 * holeR, h: 2 * holeR };
  }
  if (pad.kind === 'thru' && !pad.drill) pad.kind = 'smd';
  if (shape === 'custom') {
    const nums = (f[10] ?? '').trim().split(/\s+/).map(Number);
    const abs: Pt[] = [];
    for (let i = 0; i + 1 < nums.length; i += 2) abs.push(P(c, nums[i], nums[i + 1]));
    // custom outline is stored relative to the pad, unrotated
    pad.poly = abs.map(p => rotDown(sub(p, at), -rot));
    pad.rotation = rot;
    if (pad.poly.length < 3) { pad.shape = 'rect'; delete pad.poly; }
  }
  return pad;
}

function readText(f: string[], c: FpCtx, layer: string): Text {
  // TEXT~type~x~y~strokeWidth~rotation~mirror~layer~net~fontSize~text~path~display~id
  // EasyEDA anchors text at the start of its baseline; the model anchors at the vertical centre.
  const size = round(n(f[9], 8) * U * 0.85, 4);
  const rotation = normAngle(n(f[5]));
  const at = add(P(c, f[2], f[3]), rotDown({ x: 0, y: -size / 2 }, rotation));
  return {
    type: 'text', at, text: f[10] ?? '', size, width: n(f[4], 0.6) * U, rotation,
    mirror: f[6] === '1' || layer.startsWith('B.'), layer, role: f[1] === 'P' ? 'reference' : f[1] === 'N' ? 'value' : 'user', hidden: f[12] === 'none',
    justify: 'left',
  };
}

function read3d(json: string, c: FpCtx, r: Report): Model3D | null {
  try {
    const o = JSON.parse(json);
    const a = o.attrs ?? {};
    if (a.c_etype !== 'outline3D') return null;
    const [ox, oy] = String(a.c_origin ?? '0,0').split(',').map(Number);
    const rot = String(a.c_rotation ?? '0,0,0').split(',').map(Number);
    const at = P(c, ox, oy);
    r.approx('3D model', 'EasyEDA 3D models are referenced by name (download the STEP separately, e.g. with the KiCad JLCPCB Part Picker)');
    return { path: `\${KIPRJMOD}/3dmodels/${(a.title ?? 'model').replace(/[\\/:*?"<>|]/g, '_')}.step`, offset: [at.x, -at.y, n(a.z) * U], rotation: [-(rot[0] || 0), -(rot[1] || 0), -(rot[2] || 0)].map(v => normAngle(v)) as [number, number, number] };
  } catch { return null; }
}

/** Read the shapes of a footprint (or footprint instance on a board), in absolute footprint/board coordinates. */
export function readFpShapes(shapes: string[], c: FpCtx, out: { pads: Pad[]; graphics: Graphic[]; holes: { at: Pt; d: number }[]; models: Model3D[]; texts: Text[]; zones?: Board['zones']; tracks?: Board['tracks']; vias?: Board['vias'] }) {
  const r = c.r;
  for (const s of shapes) {
    const f = s.split('~');
    const kind = f[0];
    switch (kind) {
      case 'PAD': out.pads.push(readPad(f, c)); r.ok('pad'); break;
      case 'TRACK': {
        const layer = eeLayer(f[2]);
        if (!layer) { r.skip('track', `layer ${f[2]}`); break; }
        const nums = f[4].trim().split(/\s+/).map(Number);
        const pts: Pt[] = [];
        for (let i = 0; i + 1 < nums.length; i += 2) pts.push(P(c, nums[i], nums[i + 1]));
        const w = n(f[1]) * U;
        if (out.tracks && layer.endsWith('.Cu')) { for (let i = 1; i < pts.length; i++) out.tracks.push({ layer, width: w, a: pts[i - 1], b: pts[i], net: f[3] || undefined }); r.ok('track', pts.length - 1); }
        else { out.graphics.push({ type: 'poly', pts, width: w, layer, closed: false }); r.ok('graphic'); }
        break;
      }
      case 'ARC': {
        const layer = eeLayer(f[2]);
        if (!layer) { r.skip('arc', `layer ${f[2]}`); break; }
        const p = parsePath(f[4]);
        const w = n(f[1]) * U;
        for (const a of p.arcs) {
          const g = { start: P(c, a.start.x, a.start.y), mid: P(c, a.mid.x, a.mid.y), end: P(c, a.end.x, a.end.y) };
          if (out.tracks && layer.endsWith('.Cu')) { out.tracks.push({ layer, width: w, a: g.start, mid: g.mid, b: g.end, net: f[3] || undefined }); r.ok('track arc'); }
          else { out.graphics.push({ type: 'arc', ...g, width: w, layer }); r.ok('graphic'); }
        }
        break;
      }
      case 'CIRCLE': {
        const layer = eeLayer(f[5]);
        if (!layer) { r.skip('circle', `layer ${f[5]}`); break; }
        out.graphics.push({ type: 'circle', center: P(c, f[1], f[2]), radius: n(f[3]) * U, width: n(f[4]) * U, layer });
        r.ok('graphic'); break;
      }
      case 'RECT': {
        // RECT~x~y~width~height~layer~id~locked~strokeWidth~fill
        const layer = eeLayer(f[5]);
        if (!layer) { r.skip('rectangle', `layer ${f[5]}`); break; }
        const a = P(c, f[1], f[2]), b = P(c, n(f[1]) + n(f[3]), n(f[2]) + n(f[4]));
        out.graphics.push({ type: 'rect', a, b, width: n(f[8]) * U, layer, fill: f[9] !== 'none' && !n(f[8]) });
        r.ok('graphic'); break;
      }
      case 'SOLIDREGION': {
        const layer = eeLayer(f[1]);
        const p = parsePath(f[3]);
        const pts = p.pts.map(q => P(c, q.x, q.y));
        if (p.arcs.length) r.approx('region arc', 'arcs in solid regions become straight segments through the arc mid point');
        if (f[4] === 'npth' || f[4] === 'cutout') {
          if (f[4] === 'cutout' && out.zones) { out.zones.push({ layer: 'F.Cu', outline: pts, keepout: true }); r.approx('cutout', 'board cutout regions become keepout areas'); }
          else if (layer && f[1] !== '100') { out.graphics.push({ type: 'poly', pts, width: 0.05, layer: 'Edge.Cuts', closed: true }); r.ok('graphic'); }
          else r.skip('cutout region', 'cutout regions inside footprints are dropped');
          break;
        }
        if (!layer) { r.skip('solid region', `layer ${f[1]}`); break; }
        if (out.zones && layer.endsWith('.Cu') && f[2]) { out.zones.push({ layer, net: f[2], outline: pts }); r.approx('solid region', 'copper solid regions become zones'); break; }
        out.graphics.push({ type: 'poly', pts, width: 0, layer, fill: true, closed: true });
        r.ok('graphic'); break;
      }
      case 'HOLE': out.holes.push({ at: P(c, f[1], f[2]), d: 2 * n(f[3]) * U }); r.ok('hole'); break;
      case 'VIA': {
        const v = { at: P(c, f[1], f[2]), size: n(f[3]) * U, drill: 2 * n(f[5]) * U, net: f[4] || undefined };
        if (out.vias) { out.vias.push(v); r.ok('via'); }
        else { out.pads.push({ number: '', kind: 'thru', shape: 'circle', at: v.at, rotation: 0, w: v.size, h: v.size, drill: { w: v.drill, h: v.drill }, side: 'F' }); r.approx('via in footprint', 'vias inside footprints become unnumbered pads'); }
        break;
      }
      case 'TEXT': {
        const layer = eeLayer(f[7]);
        if (!layer) { r.skip('text', `layer ${f[7]}`); break; }
        const t = readText(f, c, layer);
        if (t.role !== 'user') out.texts.push(t); else { out.graphics.push(t); r.ok('text'); }
        break;
      }
      case 'COPPERAREA': {
        // COPPERAREA~strokeWidth~layer~net~path~clearance~fillStyle~id~thermal~keepIsland~...
        const layer = eeLayer(f[2]);
        if (!layer || !out.zones) { r.skip('copper area', 'copper areas inside footprints are dropped'); break; }
        const p = parsePath(f[4]);
        out.zones.push({ layer, net: f[3] || undefined, outline: p.pts.map(q => P(c, q.x, q.y)), clearance: n(f[5], 1.2) * U, minWidth: n(f[1], 1) * U });
        r.ok('zone'); break;
      }
      case 'SVGNODE': { const m = read3d(f.slice(1).join('~'), c, r); if (m) out.models.push(m); break; }
      case 'DIMENSION': r.skip('dimension', 'dimensions are not converted'); break;
      case 'PROTRACTOR': r.skip('protractor', 'measurement helpers are dropped'); break;
      case 'IMAGE': r.skip('image', 'images are not converted'); break;
      case 'LIB': break; // handled by the board reader
      default: r.skip(kind || 'unknown', 'unknown EasyEDA shape');
    }
  }
}

export function readEasyFootprint(doc: EeDoc, r = new Report()): Footprint {
  const ox = n(String(doc.head?.x)), oy = n(String(doc.head?.y));
  const out = { pads: [] as Pad[], graphics: [] as Graphic[], holes: [] as { at: Pt; d: number }[], models: [] as Model3D[], texts: [] as Text[] };
  readFpShapes(doc.shape ?? [], { ox, oy, r }, out);
  const name = doc.head?.c_para?.package ?? doc.title ?? 'footprint';
  for (const t of out.texts) out.graphics.push({ ...t, text: t.role === 'reference' ? '${REFERENCE}' : '${VALUE}' });
  r.ok('footprint');
  return { name, pads: out.pads, graphics: out.graphics, holes: out.holes, model3d: out.models.length ? out.models : undefined, description: doc.head?.c_para?.link };
}

// ---------------------------------------------------------------- symbols

const PIN_TYPES: Record<string, PinType> = { '0': 'passive', '1': 'input', '2': 'output', '3': 'bidirectional', '4': 'power_in' };

export function readEasySymbol(doc: EeDoc, r = new Report()): Symbol {
  const ox = n(String(doc.head?.x)), oy = n(String(doc.head?.y));
  const S = (x: string | number, y: string | number): Pt => ({ x: round((+x - ox) * U, 4), y: round(-(+y - oy) * U, 4) });
  const graphics: Graphic[] = [];
  const pins: Pin[] = [];
  for (const s of doc.shape ?? []) {
    const segs = s.split('^^');
    const f = segs[0].split('~');
    const w = n(f[0] === 'R' ? f[8] : f[0] === 'E' ? f[6] : f[3], 1) * U;
    switch (f[0]) {
      case 'P': {
        const conn = S(f[4], f[5]);
        const path = (segs[2] ?? '').split('~')[0];
        const m = /M\s*([-\d.]+)[\s,]+([-\d.]+)\s*([hvHV])\s*([-\d.]+)/.exec(path);
        let angle = 0, len = 10;
        if (m && +m[4] !== 0) {
          len = Math.abs(+m[4]);
          const dir = +m[4] >= 0 ? 1 : -1;
          angle = m[3].toLowerCase() === 'h' ? (dir > 0 ? 0 : 180) : (dir > 0 ? 270 : 90);
        } else { angle = normAngle(180 - n(f[6])); if (m) len = 0; }
        const nameSeg = (segs[3] ?? '').split('~'), numSeg = (segs[4] ?? '').split('~');
        const dot = (segs[5] ?? '').split('~')[0] === '1';
        const clk = (segs[6] ?? '').split('~')[0] === '1';
        pins.push({
          number: numSeg[4] ?? f[3], name: nameSeg[0] === '1' ? (nameSeg[4] ?? '') : (nameSeg[4] ?? ''), at: conn, length: round(len * U, 4), angle,
          type: PIN_TYPES[f[2]] ?? 'unspecified', hidden: f[1] === 'none', shape: dot && clk ? 'inverted_clock' : dot ? 'inverted' : clk ? 'clock' : 'line',
        });
        r.ok('pin');
        break;
      }
      case 'R': {
        // R~x~y~rx~ry~width~height~stroke~strokeWidth~style~fill~id
        graphics.push({ type: 'rect', a: S(f[1], f[2]), b: S(n(f[1]) + n(f[5]), n(f[2]) + n(f[6])), width: w, layer: 'symbol', fill: !!f[10] && f[10] !== 'none' });
        if (n(f[3])) r.approx('rounded rectangle', 'rounded corners on symbol rectangles are dropped');
        r.ok('symbol graphic'); break;
      }
      case 'E': {
        const rx = n(f[3]), ry = n(f[4]);
        graphics.push({ type: 'circle', center: S(f[1], f[2]), radius: ((rx + ry) / 2) * U, width: w, layer: 'symbol', fill: !!f[8] && f[8] !== 'none' });
        if (Math.abs(rx - ry) > 1e-6) r.approx('ellipse', 'ellipses become circles');
        r.ok('symbol graphic'); break;
      }
      case 'PL': case 'PG': {
        const nums = f[1].trim().split(/[\s,]+/).map(Number);
        const pts: Pt[] = [];
        for (let i = 0; i + 1 < nums.length; i += 2) pts.push(S(nums[i], nums[i + 1]));
        graphics.push({ type: 'poly', pts, width: w, layer: 'symbol', closed: f[0] === 'PG', fill: f[0] === 'PG' && !!f[5] && f[5] !== 'none' });
        r.ok('symbol graphic'); break;
      }
      case 'PT': case 'A': {
        const p = parsePath(f[1]);
        if (f[0] === 'A' || p.arcs.length) for (const a of p.arcs) graphics.push({ type: 'arc', start: S(a.start.x, a.start.y), mid: S(a.mid.x, a.mid.y), end: S(a.end.x, a.end.y), width: w, layer: 'symbol' });
        else graphics.push({ type: 'poly', pts: p.pts.map(q => S(q.x, q.y)), width: w, layer: 'symbol', closed: p.closed, fill: p.closed && !!f[5] && f[5] !== 'none' });
        r.ok('symbol graphic'); break;
      }
      case 'T': {
        if (f[1] !== 'L' || f[13] === '0') { if (f[1] !== 'L') r.ok('symbol label'); break; }
        const size = parseFloat(f[7]) || 7;
        graphics.push({ type: 'text', at: S(f[2], f[3]), text: f[12] ?? '', size: round(size * 0.3528 * 0.8, 3), width: 0, rotation: normAngle(n(f[4])), layer: 'symbol', justify: f[14] === 'start' ? 'left' : f[14] === 'end' ? 'right' : 'center' });
        r.ok('symbol graphic'); break;
      }
      case 'J': case 'N': case 'B': r.skip('symbol element', `${f[0]} items are schematic-only`); break;
      default: if (f[0]) r.skip(f[0], 'unknown EasyEDA symbol shape');
    }
  }
  const cp = doc.head?.c_para ?? {};
  const props: Record<string, string> = {};
  for (const k of ['Manufacturer', 'Manufacturer Part', 'Supplier', 'Supplier Part', 'JLCPCB Part Class']) if (cp[k]) props[k] = cp[k];
  r.ok('symbol');
  return {
    name: cp.name ?? doc.title ?? 'symbol', reference: (cp.pre ?? 'U?').replace(/\?$/, ''), value: cp.Value ?? cp.name,
    footprint: cp.package, datasheet: cp.link, properties: props, units: [{ graphics, pins }],
  };
}

// ---------------------------------------------------------------- boards

export function readEasyBoard(doc: EeDoc, r = new Report(), name = 'board'): Board {
  // board coordinates are relative to the canvas origin stored in the header
  const c: FpCtx = { ox: n(String(doc.head?.x ?? 0)), oy: n(String(doc.head?.y ?? 0)), r };
  const b: Board = { name, copperLayers: 2, footprints: [], tracks: [], vias: [], zones: [], graphics: [], holes: [], nets: [] };
  const pads: Pad[] = [];
  const texts: Text[] = [];
  const models: Model3D[] = [];
  readFpShapes((doc.shape ?? []).filter(s => !s.startsWith('LIB~')), c, { pads, graphics: b.graphics, holes: b.holes, models, texts, zones: b.zones, tracks: b.tracks, vias: b.vias });
  b.graphics.push(...texts);
  if (pads.length) r.approx('free pad', 'free pads on the board become single-pad footprints');
  pads.forEach((p, i) => b.footprints.push({ ref: `PAD${i + 1}`, value: '', at: p.at, rotation: 0, side: p.side === 'B' ? 'bottom' : 'top', footprint: { name: 'FreePad', pads: [{ ...p, at: { x: 0, y: 0 } }], graphics: [] } }));
  for (const s of doc.shape ?? []) {
    if (!s.startsWith('LIB~')) continue;
    const parts = s.split('#@$');
    const head = parts[0].split('~');
    const at = P(c, head[1], head[2]);
    const attrs = parseBacktick(head[3]);
    const rot = normAngle(n(head[4]));
    const out = { pads: [] as Pad[], graphics: [] as Graphic[], holes: [] as { at: Pt; d: number }[], models: [] as Model3D[], texts: [] as Text[] };
    readFpShapes(parts.slice(1), c, out);
    const bottom = out.pads.length ? out.pads.every(p => p.kind !== 'smd' || p.side === 'B') && out.pads.some(p => p.side === 'B')
      : out.graphics.some(g => g.layer.startsWith('B.'));
    const toLocal = (p: Pt) => rotDown(sub(p, at), -rot);
    const fp: Footprint = {
      name: attrs.package ?? 'footprint',
      pads: out.pads.map(p => ({ ...p, at: toLocal(p.at), rotation: normAngle(p.rotation - rot) })),
      graphics: out.graphics.map(g => mapLocal(g, toLocal, rot)),
      holes: out.holes.map(h => ({ ...h, at: toLocal(h.at) })),
      model3d: out.models.map(m => { const l = toLocal({ x: m.offset[0], y: -m.offset[1] }); return { ...m, offset: [l.x, -l.y, m.offset[2]] as [number, number, number] }; }),
    };
    const ref = out.texts.find(t => t.role === 'reference'), val = out.texts.find(t => t.role === 'value');
    const pf: PlacedFootprint = {
      ref: ref?.text ?? '', value: val?.text ?? attrs.package ?? '', at, rotation: rot, side: bottom ? 'bottom' : 'top', footprint: fp,
      texts: out.texts.map(t => ({ ...t, at: toLocal(t.at), rotation: normAngle(t.rotation - rot) })),
    };
    b.footprints.push(pf);
    r.ok('footprint');
  }
  const nets = new Set<string>();
  for (const t of b.tracks) if (t.net) nets.add(t.net);
  for (const v of b.vias) if (v.net) nets.add(v.net);
  for (const f of b.footprints) for (const p of f.footprint.pads) if (p.net) nets.add(p.net);
  b.nets = [...nets];
  const inner = [...b.tracks.map(t => t.layer), ...b.zones.map(z => z.layer)].map(l => /^In(\d+)/.exec(l)).filter(Boolean).map(m => +m![1]);
  b.copperLayers = 2 + (inner.length ? Math.max(...inner) : 0);
  return b;
}

function mapLocal(g: Graphic, f: (p: Pt) => Pt, rot: number): Graphic {
  switch (g.type) {
    case 'line': return { ...g, a: f(g.a), b: f(g.b) };
    case 'arc': return { ...g, start: f(g.start), mid: f(g.mid), end: f(g.end) };
    case 'circle': return { ...g, center: f(g.center) };
    case 'rect': { const pts = [g.a, { x: g.b.x, y: g.a.y }, g.b, { x: g.a.x, y: g.b.y }].map(f); return { type: 'poly', pts, width: g.width, layer: g.layer, fill: g.fill, closed: true }; }
    case 'poly': return { ...g, pts: g.pts.map(f) };
    case 'text': return { ...g, at: f(g.at), rotation: normAngle(g.rotation - rot) };
  }
}

export function parseBacktick(s: string | undefined): Record<string, string> {
  const o: Record<string, string> = {};
  const p = (s ?? '').split('`');
  for (let i = 0; i + 1 < p.length; i += 2) o[p[i]] = p[i + 1];
  return o;
}

// ---------------------------------------------------------------- documents

export interface EeDoc { head?: { docType?: string; x?: number | string; y?: number | string; c_para?: Record<string, string> }; shape?: string[]; title?: string; canvas?: string; schematics?: unknown[] }

/** Accepts every JSON flavour EasyEDA Standard produces: an exported document, the component API response,
 *  or {dataStr, packageDetail}. */
export function readEasyEda(json: unknown, r = new Report(), name = 'easyeda'): { kind: 'library'; library: Library } | { kind: 'board'; board: Board } {
  let o = json as Record<string, unknown>;
  if (o && typeof o === 'object' && 'result' in o && o.result) o = o.result as Record<string, unknown>;
  const asDoc = (x: unknown): EeDoc | undefined => { if (!x) return undefined; if (typeof x === 'string') { try { return JSON.parse(x); } catch { return undefined; } } return x as EeDoc; };
  if (o.dataStr) {
    const sym = asDoc(o.dataStr);
    const pkg = asDoc((o.packageDetail as Record<string, unknown> | undefined)?.dataStr);
    const lib: Library = { symbols: [], footprints: [] };
    if (sym && sym.head?.docType !== '4') { const s = readEasySymbol({ ...sym, title: o.title as string }, r); lib.symbols.push(s); }
    if (pkg) { const fp = readEasyFootprint(pkg, r); lib.footprints.push(fp); if (lib.symbols[0]) lib.symbols[0].footprint = fp.name; }
    else if (sym?.head?.docType === '4') lib.footprints.push(readEasyFootprint(sym, r));
    return { kind: 'library', library: lib };
  }
  const doc = o as EeDoc;
  if (doc.schematics) throw new Error('EasyEDA schematic projects are not supported yet (libraries and PCBs are).');
  const t = String(doc.head?.docType ?? '');
  if (t === '3') return { kind: 'board', board: readEasyBoard(doc, r, name) };
  if (t === '4') return { kind: 'library', library: { symbols: [], footprints: [readEasyFootprint(doc, r)] } };
  if (t === '2') return { kind: 'library', library: { symbols: [readEasySymbol(doc, r)], footprints: [] } };
  if (t === '1') throw new Error('EasyEDA schematics are not supported yet (libraries and PCBs are).');
  // fall back to sniffing the shapes
  const shapes = doc.shape ?? [];
  if (shapes.some(s => s.startsWith('LIB~') || s.startsWith('VIA~'))) return { kind: 'board', board: readEasyBoard(doc, r, name) };
  if (shapes.some(s => s.startsWith('PAD~'))) return { kind: 'library', library: { symbols: [], footprints: [readEasyFootprint(doc, r)] } };
  if (shapes.some(s => s.startsWith('P~'))) return { kind: 'library', library: { symbols: [readEasySymbol(doc, r)], footprints: [] } };
  throw new Error('Unrecognised EasyEDA document');
}

export { add };
