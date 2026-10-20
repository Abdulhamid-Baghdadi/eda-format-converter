/**
 * Altium Designer PCB files (.PcbDoc boards, .PcbLib footprint libraries): read-only.
 * Both are OLE compound files. Text records are `|KEY=VALUE|` strings; geometric primitives are
 * little-endian binary records. Coordinates are 1/10000 mil (2.54 nm), Y up.
 * Written for this project; record layouts were cross-checked against real files and the
 * Apache-2.0 AltiumSharp documentation of the format.
 */
import { readCfb } from './cfb';
import type { Board, Footprint, Graphic, Pad, PlacedFootprint, Pt, Text, Zone, Library } from '../model';
import { normAngle, rotDown, sub, round, rotUp, add } from '../geom';
import { Report } from '../report';

const UNIT = 2.54e-6; // mm per Altium internal unit
const mm = (v: number) => round(v * UNIT, 6);

// ---------------------------------------------------------------- low-level helpers
class Reader {
  pos = 0;
  readonly dv: DataView;
  constructor(public buf: Uint8Array) { this.dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength); }
  get more() { return this.pos < this.buf.length; }
  u8() { return this.buf[this.pos++]; }
  u32() { const v = this.dv.getUint32(this.pos, true); this.pos += 4; return v; }
  /** A length-prefixed block (the top byte of the length is a flag). */
  block(): Uint8Array { const n = this.u32() & 0x00ffffff; const b = this.buf.subarray(this.pos, this.pos + n); this.pos += n; return b; }
}
const latin1 = (b: Uint8Array) => { let s = ''; for (const c of b) s += String.fromCharCode(c); return s; };
/** Pascal string inside a block. */
const pstr = (b: Uint8Array) => (b.length ? latin1(b.subarray(1, 1 + b[0])) : '');

export function parseProps(s: string): Record<string, string> {
  const o: Record<string, string> = {};
  for (const part of s.replace(/\0+$/, '').split('|')) {
    const i = part.indexOf('=');
    if (i > 0) o[part.slice(0, i).toUpperCase()] = part.slice(i + 1);
  }
  return o;
}
/** Sequence of length-prefixed text records (Components6, Nets6, Polygons6 ...). */
function textRecords(data: Uint8Array | undefined): Record<string, string>[] {
  const out: Record<string, string>[] = [];
  if (!data) return out;
  const r = new Reader(data);
  while (r.pos + 4 <= data.length) out.push(parseProps(latin1(r.block())));
  return out;
}
/** "1234.5mil" / "2.54mm" -> mm */
export function dim(v: string | undefined, d = 0): number {
  if (v === undefined) return d;
  const m = /^\s*([-+\d.eE]+)\s*(mil|mm|in)?\s*$/.exec(v);
  if (!m) return d;
  const n = parseFloat(m[1]);
  return m[2] === 'mm' ? n : m[2] === 'in' ? n * 25.4 : n * 0.0254;
}
const num = (v: string | undefined, d = 0) => { const n = parseFloat(v ?? ''); return Number.isFinite(n) ? n : d; };
const decodeWide = (s: string) => s.split(',').map(c => String.fromCharCode(+c)).join('');

// ---------------------------------------------------------------- layers
const NAMED: Record<string, number> = { TOP: 1, BOTTOM: 32, TOPOVERLAY: 33, BOTTOMOVERLAY: 34, TOPPASTE: 35, BOTTOMPASTE: 36, TOPSOLDER: 37, BOTTOMSOLDER: 38, DRILLGUIDE: 55, KEEPOUT: 56, DRILLDRAWING: 73, MULTILAYER: 74 };
export function layerIdFromName(n: string): number {
  n = n.toUpperCase();
  if (NAMED[n]) return NAMED[n];
  let m = /^MID(\d+)$/.exec(n); if (m) return 1 + +m[1];
  m = /^PLANE(\d+)$/.exec(n); if (m) return 38 + +m[1];
  m = /^MECHANICAL(\d+)$/.exec(n); if (m) return 56 + +m[1];
  return 0;
}

/** Maps Altium layer ids to model layers. Inner copper is numbered in stack order. */
class Layers {
  inner = new Map<number, number>();
  constructor(board?: Record<string, string>) {
    if (!board) return;
    // follow the stack from the top layer
    const seen = new Set<number>();
    let id = +(board.LAYER1NEXT ?? 0), k = 0;
    while (id && id !== 32 && !seen.has(id) && k < 64) { seen.add(id); this.inner.set(id, ++k); id = +(board[`LAYER${id}NEXT`] ?? 0); }
  }
  get copper() { return 2 + this.inner.size; }
  map(id: number, r: Report): string | null {
    if (id === 1) return 'F.Cu';
    if (id === 32) return 'B.Cu';
    if ((id >= 2 && id <= 31) || (id >= 39 && id <= 54)) {
      if (!this.inner.has(id)) this.inner.set(id, this.inner.size + 1);
      return `In${this.inner.get(id)}.Cu`;
    }
    switch (id) {
      case 33: return 'F.SilkS'; case 34: return 'B.SilkS'; case 35: return 'F.Paste'; case 36: return 'B.Paste';
      case 37: return 'F.Mask'; case 38: return 'B.Mask'; case 56: return 'Keepout';
    }
    if (id >= 57 && id <= 72) { r.approx('mechanical layer', 'Altium mechanical layers go to Dwgs.User (their meaning is project-specific)'); return 'Dwgs.User'; }
    return null; // drill guide/drawing, multi-layer (pads only)
  }
}

// ---------------------------------------------------------------- primitives
interface Common { layer: number; flags: number; net: number; polygon: number; comp: number }
function common(b: Uint8Array): Common {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return { layer: b[0], flags: dv.getUint16(1, true), net: dv.getUint16(3, true), polygon: dv.getUint16(5, true), comp: dv.getUint16(7, true) };
}
const i32 = (b: Uint8Array, o: number) => (o + 4 <= b.length ? new DataView(b.buffer, b.byteOffset, b.byteLength).getInt32(o, true) : 0);
const f64 = (b: Uint8Array, o: number) => (o + 8 <= b.length ? new DataView(b.buffer, b.byteOffset, b.byteLength).getFloat64(o, true) : 0);
const P = (x: number, y: number): Pt => ({ x: mm(x), y: -mm(y) }); // Y flips: the model is Y-down

type Prim =
  | { kind: 'arc'; c: Common; center: Pt; r: number; sa: number; ea: number; width: number }
  | { kind: 'track'; c: Common; a: Pt; b: Pt; width: number }
  | { kind: 'via'; c: Common; at: Pt; d: number; drill: number; from: number; to: number }
  | { kind: 'pad'; c: Common; pad: Pad; holeOffset: boolean }
  | { kind: 'text'; c: Common; t: Text; comment: boolean; designator: boolean; ttf: boolean }
  | { kind: 'fill'; c: Common; pts: Pt[] }
  | { kind: 'region'; c: Common; pts: Pt[]; props: Record<string, string>; holes: number }
  | { kind: 'body'; c: Common };

const BLOCKS: Record<number, number> = { 1: 1, 2: 6, 3: 1, 4: 1, 5: 2, 6: 1, 11: 1, 12: 1 };

function readPad(blocks: Uint8Array[]): { pad: Pad; c: Common; holeOffset: boolean } {
  const name = pstr(blocks[0]);
  const b = blocks[4];
  const c = common(b);
  const at = P(i32(b, 13), i32(b, 17));
  const w = mm(i32(b, 21)), h = mm(i32(b, 25));
  const hole = mm(i32(b, 45));
  let shape = b[49];
  const rotation = normAngle(f64(b, 52));
  const plated = b[60] !== 0;
  const ss = blocks[5];
  let holeShape = 0, slot = 0, holeRot = 0, radius = 0, holeOffset = false;
  if (ss && ss.length >= 596) {
    const sdv = new DataView(ss.buffer, ss.byteOffset, ss.byteLength);
    holeShape = ss[262];
    slot = mm(sdv.getInt32(263, true));
    holeRot = sdv.getFloat64(267, true);
    holeOffset = sdv.getInt32(275, true) !== 0 || sdv.getInt32(403, true) !== 0;
    if (ss[531]) { shape = ss[532]; radius = ss[564]; }
  }
  const pad: Pad = {
    number: name, kind: c.layer === 74 ? (plated ? 'thru' : 'npth') : 'smd', at, rotation, w, h,
    side: c.layer === 32 ? 'B' : 'F',
    shape: shape === 2 ? 'rect' : shape === 3 ? 'octagon' : shape === 9 ? 'roundrect' : Math.abs(w - h) < 1e-6 ? 'circle' : 'oval',
  };
  if (pad.shape === 'roundrect') pad.roundRatio = Math.min(0.5, (radius || 50) / 200);
  if (pad.kind !== 'smd' && hole > 0) {
    if (holeShape === 2 && slot > hole) {
      const along = Math.round(normAngle(holeRot) / 90) % 2 === 0;
      pad.drill = along ? { w: slot, h: hole } : { w: hole, h: slot };
    } else pad.drill = { w: hole, h: hole };
  }
  if (pad.kind === 'npth' && !pad.drill) pad.drill = { w: hole || w, h: hole || h };
  return { pad, c, holeOffset };
}

function readText(blocks: Uint8Array[], wide: string[]): Prim {
  const b = blocks[0];
  const c = common(b);
  const height = mm(i32(b, 21));
  const rot = normAngle(f64(b, 27));
  const mirror = b[35] !== 0;
  const stroke = mm(i32(b, 36));
  const wi = i32(b, 115);
  let text = pstr(blocks[1]);
  if (b.length >= 119 && wi >= 0 && wi < wide.length && wide[wi]) text = wide[wi];
  // Altium anchors text at its bottom-left; the model anchors at the vertical centre
  const base = P(i32(b, 13), i32(b, 17));
  const up = rotDown({ x: 0, y: -height / 2 }, rot);
  const t: Text = { type: 'text', at: add(base, up), text, size: height, width: stroke || height * 0.12, rotation: rot, mirror, justify: mirror ? 'right' : 'left', layer: '' };
  return { kind: 'text', c, t, comment: b[40] !== 0, designator: b[41] !== 0, ttf: b[43] === 1 };
}

function readRegion(b: Uint8Array): Prim {
  const c = common(b);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const holes = dv.getUint16(14, true);
  let o = 18;
  const plen = dv.getUint32(o, true) & 0xffffff; o += 4;
  const props = parseProps(latin1(b.subarray(o, o + plen))); o += plen;
  const n = o + 4 <= b.length ? dv.getUint32(o, true) : 0; o += 4;
  const pts: Pt[] = [];
  for (let i = 0; i < n && o + 16 <= b.length; i++, o += 16) pts.push(P(dv.getFloat64(o, true), dv.getFloat64(o + 8, true)));
  return { kind: 'region', c, pts, props, holes };
}

/** Parse a stream of primitive records: [type byte][blocks...]. */
function readPrims(data: Uint8Array, wide: string[], r: Report): Prim[] {
  const rd = new Reader(data);
  const out: Prim[] = [];
  while (rd.pos < data.length) {
    const type = rd.u8();
    const nb = BLOCKS[type];
    if (!nb) { r.skip('unknown record', `record type ${type}: the rest of this stream is skipped`); break; }
    const blocks: Uint8Array[] = [];
    for (let i = 0; i < nb && rd.pos + 4 <= data.length; i++) blocks.push(rd.block());
    if (blocks.length < nb) break;
    const b = blocks[0];
    switch (type) {
      case 1: out.push({ kind: 'arc', c: common(b), center: P(i32(b, 13), i32(b, 17)), r: mm(i32(b, 21)), sa: f64(b, 25), ea: f64(b, 33), width: mm(i32(b, 41)) }); break;
      case 2: { const p = readPad(blocks); out.push({ kind: 'pad', ...p }); break; }
      case 3: out.push({ kind: 'via', c: common(b), at: P(i32(b, 13), i32(b, 17)), d: mm(i32(b, 21)), drill: mm(i32(b, 25)), from: b[29], to: b[30] }); break;
      case 4: out.push({ kind: 'track', c: common(b), a: P(i32(b, 13), i32(b, 17)), b: P(i32(b, 21), i32(b, 25)), width: mm(i32(b, 29)) }); break;
      case 5: out.push(readText(blocks, wide)); break;
      case 6: {
        const a = P(i32(b, 13), i32(b, 17)), c2 = P(i32(b, 21), i32(b, 25)), rot = f64(b, 29);
        const ctr = { x: (a.x + c2.x) / 2, y: (a.y + c2.y) / 2 };
        const pts = [a, { x: c2.x, y: a.y }, c2, { x: a.x, y: c2.y }].map(p => add(ctr, rotDown(sub(p, ctr), rot)));
        out.push({ kind: 'fill', c: common(b), pts });
        break;
      }
      case 11: out.push(readRegion(b)); break;
      case 12: out.push({ kind: 'body', c: common(b) }); break;
    }
  }
  return out;
}

/** Arc in Altium terms (centre, radius, start/end angle CCW in Y-up) -> three points in the Y-down model. */
function arcPts(center: Pt, r: number, sa: number, ea: number) {
  let sweep = normAngle(ea - sa);
  if (sweep === 0) sweep = 360;
  const at = (a: number) => { const v = rotUp({ x: r, y: 0 }, a); return { x: center.x + v.x, y: center.y - v.y }; };
  return { start: at(sa), mid: at(sa + sweep / 2), end: at(sa + sweep), full: sweep >= 359.999 };
}

/** Convert primitives to model graphics/pads; returns what was produced. */
function toModel(prims: Prim[], L: Layers, r: Report, nets: string[]) {
  const pads: Pad[] = [], graphics: Graphic[] = [], texts: { t: Text; role: 'reference' | 'value' | 'user' }[] = [];
  const tracks: Board['tracks'] = [], vias: Board['vias'] = [], zones: Zone[] = [], holes: Board['holes'] = [];
  for (const p of prims) {
    const net = p.c.net !== 0xffff && nets[p.c.net] ? nets[p.c.net] : undefined;
    if (p.kind === 'pad') { if (net) p.pad.net = net; if (p.holeOffset) r.approx('pad hole offset', 'pads whose hole is offset from the copper keep a centred hole'); pads.push(p.pad); r.ok('pad'); continue; }
    if (p.kind === 'via') { vias.push({ at: p.at, size: p.d, drill: p.drill, net, from: L.map(p.from, r) ?? 'F.Cu', to: L.map(p.to, r) ?? 'B.Cu' }); r.ok('via'); continue; }
    if (p.kind === 'body') { r.skip('3D body', '3D component bodies are not converted'); continue; }
    const layer = L.map(p.c.layer, r);
    if (!layer) { r.skip(`${p.kind} on layer ${p.c.layer}`, 'drill drawings and multi-layer graphics are not converted'); continue; }
    const copper = layer.endsWith('.Cu');
    const keep = layer === 'Keepout' || (p.c.flags & 0x200) !== 0;
    switch (p.kind) {
      case 'track':
        if (keep) { graphics.push({ type: 'line', a: p.a, b: p.b, width: p.width, layer: 'Cmts.User' }); r.approx('keepout track', 'keepout tracks become drawings on Cmts.User'); }
        else if (copper && p.c.comp === 0xffff) { tracks.push({ layer, width: p.width, a: p.a, b: p.b, net }); r.ok('track'); }
        else { graphics.push({ type: 'line', a: p.a, b: p.b, width: p.width, layer }); r.ok('graphic'); }
        break;
      case 'arc': {
        const a = arcPts(p.center, p.r, p.sa, p.ea);
        if (!a.full && Math.hypot(a.start.x - a.end.x, a.start.y - a.end.y) < 0.01 && p.r * Math.PI * normAngle(p.ea - p.sa) / 180 < 0.01) { r.skip('degenerate arc', 'arcs shorter than 10 µm are dropped'); break; }
        const l = keep ? 'Cmts.User' : layer;
        if (a.full) graphics.push({ type: 'circle', center: p.center, radius: p.r, width: p.width, layer: l });
        else if (copper && !keep && p.c.comp === 0xffff) tracks.push({ layer, width: p.width, a: a.start, mid: a.mid, b: a.end, net });
        else graphics.push({ type: 'arc', start: a.start, mid: a.mid, end: a.end, width: p.width, layer: l });
        r.ok(copper && p.c.comp === 0xffff ? 'track arc' : 'graphic');
        break;
      }
      case 'fill':
        if (copper && p.c.comp === 0xffff && !keep) { zones.push({ layer, net, outline: p.pts }); r.approx('copper fill', 'free copper fills become zones'); }
        else { graphics.push({ type: 'poly', pts: p.pts, width: 0, fill: true, closed: true, layer: keep ? 'Cmts.User' : layer }); r.ok('graphic'); }
        break;
      case 'region': {
        if (p.c.polygon !== 0xffff && p.c.polygon !== 0 && p.c.comp === 0xffff) break; // pour fill: the polygon outline is used instead
        if (p.props.ISBOARDCUTOUT === 'TRUE') { graphics.push({ type: 'poly', pts: p.pts, width: 0.05, closed: true, layer: 'Edge.Cuts' }); r.ok('board cutout'); break; }
        if (p.props.KIND === '1' || keep) { zones.push({ layer: copper ? layer : 'F.Cu', outline: p.pts, keepout: true }); r.approx('cutout region', 'polygon cutouts and keepout regions become keepout areas'); break; }
        if (copper && p.c.comp === 0xffff) { zones.push({ layer, net, outline: p.pts }); r.approx('copper region', 'free copper regions become zones'); break; }
        graphics.push({ type: 'poly', pts: p.pts, width: 0, fill: true, closed: true, layer });
        if (p.holes) r.approx('region hole', 'holes inside filled regions are dropped');
        r.ok('graphic');
        break;
      }
      case 'text': {
        const t = { ...p.t, layer: keep ? 'Cmts.User' : layer };
        if (p.ttf) r.approx('TrueType text', 'TrueType text uses the stroke font in the target');
        texts.push({ t, role: p.designator ? 'reference' : p.comment ? 'value' : 'user' });
        break;
      }
    }
  }
  return { pads, graphics, texts, tracks, vias, zones, holes };
}

// ---------------------------------------------------------------- PcbLib
export function readAltiumPcbLib(data: Uint8Array, r = new Report()): Library {
  const s = readCfb(data);
  const L = new Layers();
  const names = new Set<string>();
  for (const k of s.keys()) { const m = /^([^/]+)\/Data$/.exec(k); if (m && m[1] !== 'FileVersionInfo' && m[1] !== 'Library') names.add(m[1]); }
  const footprints: Footprint[] = [];
  for (const storage of names) {
    const params = parseProps(latin1(new Reader(s.get(`${storage}/Parameters`) ?? new Uint8Array(4)).block()));
    const wideRaw = s.get(`${storage}/WideStrings`);
    const wideProps = wideRaw ? parseProps(latin1(new Reader(wideRaw).block())) : {};
    const wide: string[] = [];
    for (let i = 0; wideProps[`ENCODEDTEXT${i}`] !== undefined; i++) wide.push(decodeWide(wideProps[`ENCODEDTEXT${i}`]));
    const data2 = s.get(`${storage}/Data`)!;
    const rd = new Reader(data2);
    const name = pstr(rd.block()) || params.PATTERN || storage;
    const prims = readPrims(data2.subarray(rd.pos), wide, r);
    const m = toModel(prims, L, r, []);
    // in a library every copper item belongs to the footprint
    const graphics: Graphic[] = [
      ...m.graphics,
      ...m.tracks.map(t => (t.mid ? { type: 'arc' as const, start: t.a, mid: t.mid, end: t.b, width: t.width, layer: t.layer } : { type: 'line' as const, a: t.a, b: t.b, width: t.width, layer: t.layer })),
      ...m.zones.map(z => ({ type: 'poly' as const, pts: z.outline, width: 0, fill: !z.keepout, closed: true, layer: z.keepout ? 'Cmts.User' : z.layer })),
      ...m.texts.map(x => (x.role === 'reference' ? { ...x.t, text: '${REFERENCE}' } : x.role === 'value' ? { ...x.t, text: '${VALUE}' } : x.t)),
    ];
    for (const v of m.vias) m.pads.push({ number: '', kind: 'thru', shape: 'circle', at: v.at, rotation: 0, w: v.size, h: v.size, drill: { w: v.drill, h: v.drill }, side: 'F' });
    footprints.push({ name, description: params.DESCRIPTION || undefined, pads: m.pads, graphics });
    r.ok('footprint');
  }
  footprints.sort((a, b) => a.name.localeCompare(b.name));
  return { symbols: [], footprints };
}

// ---------------------------------------------------------------- PcbDoc
export function readAltiumPcbDoc(data: Uint8Array, r = new Report(), name = 'board'): Board {
  const s = readCfb(data);
  const boardProps = textRecords(s.get('Board6/Data'))[0] ?? {};
  const L = new Layers(boardProps);
  const nets = textRecords(s.get('Nets6/Data')).map(n => n.NAME ?? '');
  const comps = textRecords(s.get('Components6/Data'));
  const polys = textRecords(s.get('Polygons6/Data'));
  // wide strings: [u32 index][u32 byte length][UTF-16LE]
  const wide: string[] = [];
  const ws = s.get('WideStrings6/Data');
  if (ws) {
    const dv = new DataView(ws.buffer, ws.byteOffset, ws.byteLength);
    for (let o = 0; o + 8 <= ws.length;) {
      const idx = dv.getInt32(o, true), n = dv.getInt32(o + 4, true); o += 8;
      if (n < 0 || o + n > ws.length) break;
      let t = ''; for (let i = 0; i + 1 < n; i += 2) { const ch = dv.getUint16(o + i, true); if (!ch) break; t += String.fromCharCode(ch); }
      o += n; if (idx >= 0) wide[idx] = t;
    }
  }
  const emb = textRecords(s.get('EmbeddedBoards6/Data'));
  if (emb.length) r.skip('embedded board', `this is a panel of ${emb.length} embedded board(s); open the source board to convert its contents`, emb.length);
  const prims: Prim[] = [];
  for (const st of ['Arcs6', 'Pads6', 'Vias6', 'Tracks6', 'Texts6', 'Fills6', 'Regions6', 'ComponentBodies6']) {
    const d = s.get(`${st}/Data`);
    if (d) prims.push(...readPrims(d, wide, r));
  }
  const b: Board = { name, copperLayers: 2, footprints: [], tracks: [], vias: [], zones: [], graphics: [], holes: [], nets: nets.filter(Boolean) };

  // board outline from the board record's vertex list
  const V = (i: number) => ({ x: dim(boardProps[`VX${i}`]), y: -dim(boardProps[`VY${i}`]) });
  let nv = 0; while (boardProps[`VX${nv}`] !== undefined) nv++;
  for (let i = 0; i + 1 < nv; i++) {
    const a = V(i), c = V(i + 1);
    if (boardProps[`KIND${i}`] === '1') {
      const ctr = { x: dim(boardProps[`CX${i}`]), y: -dim(boardProps[`CY${i}`]) };
      const arc = arcPts(ctr, dim(boardProps[`R${i}`]), num(boardProps[`SA${i}`]), num(boardProps[`EA${i}`]));
      // the segment runs from vertex i to vertex i+1 along this arc, in whichever direction matches
      b.graphics.push({ type: 'arc', start: a, mid: arc.mid, end: c, width: 0.05, layer: 'Edge.Cuts' });
    } else if (Math.hypot(a.x - c.x, a.y - c.y) > 1e-9) b.graphics.push({ type: 'line', a, b: c, width: 0.05, layer: 'Edge.Cuts' });
  }
  if (nv) r.ok('board outline segment', nv - 1);

  // split primitives into free ones and per-component ones
  const byComp = new Map<number, Prim[]>();
  const free: Prim[] = [];
  for (const p of prims) { if (p.c.comp !== 0xffff && p.c.comp < comps.length) { const a = byComp.get(p.c.comp) ?? []; a.push(p); byComp.set(p.c.comp, a); } else free.push(p); }
  const fm = toModel(free, L, r, nets);
  b.tracks.push(...fm.tracks); b.vias.push(...fm.vias); b.zones.push(...fm.zones); b.graphics.push(...fm.graphics, ...fm.texts.map(t => t.t));
  for (const p of fm.pads) { if (p.kind === 'npth' && p.drill) { b.holes.push({ at: p.at, d: Math.min(p.drill.w, p.drill.h) }); r.ok('hole'); continue; } b.footprints.push({ ref: `PAD${b.footprints.length + 1}`, value: '', at: p.at, rotation: 0, side: p.side === 'B' ? 'bottom' : 'top', footprint: { name: 'FreePad', pads: [{ ...p, at: { x: 0, y: 0 } }], graphics: [] }, texts: (['reference', 'value'] as const).map(role => ({ type: 'text' as const, role, text: '', at: { x: 0, y: 0 }, size: 1, width: 0.15, rotation: 0, layer: 'F.Fab', hidden: true })) }); r.approx('free pad', 'free pads become single-pad footprints'); }

  // polygon pours -> zones (outline from the polygon record)
  for (const pr of polys) {
    const layer = L.map(layerIdFromName(pr.LAYER ?? ''), r);
    if (!layer) continue;
    const pts: Pt[] = [];
    let n = 0; while (pr[`VX${n}`] !== undefined) n++;
    for (let i = 0; i < n; i++) {
      const v = { x: dim(pr[`VX${i}`]), y: -dim(pr[`VY${i}`]) };
      pts.push(v);
      if (pr[`KIND${i}`] === '1' && i + 1 < n) { const a = arcPts({ x: dim(pr[`CX${i}`]), y: -dim(pr[`CY${i}`]) }, dim(pr[`R${i}`]), num(pr[`SA${i}`]), num(pr[`EA${i}`])); pts.push(a.mid); }
    }
    if (pts.length > 1 && Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y) < 1e-6) pts.pop();
    const net = pr.NET !== undefined && nets[+pr.NET] ? nets[+pr.NET] : undefined;
    if (pts.length >= 3) { b.zones.push({ layer, net, outline: pts, minWidth: dim(pr.TRACKWIDTH, 0.25) || 0.25, clearance: undefined }); r.ok('zone'); }
    if (pr.SHELVED === 'TRUE') r.info(`Polygon on ${layer}${net ? ` (${net})` : ''} was shelved in Altium; it is converted as a normal zone.`);
  }

  comps.forEach((cp, i) => {
    const at = { x: dim(cp.X), y: -dim(cp.Y) };
    const rot = normAngle(num(cp.ROTATION));
    const bottom = (cp.LAYER ?? 'TOP').toUpperCase() === 'BOTTOM';
    const m = toModel(byComp.get(i) ?? [], L, r, nets);
    const local = (p: Pt) => rotDown(sub(p, at), -rot);
    const lg = (g: Graphic): Graphic => {
      switch (g.type) {
        case 'line': return { ...g, a: local(g.a), b: local(g.b) };
        case 'arc': return { ...g, start: local(g.start), mid: local(g.mid), end: local(g.end) };
        case 'circle': return { ...g, center: local(g.center) };
        case 'rect': return { type: 'poly', pts: [g.a, { x: g.b.x, y: g.a.y }, g.b, { x: g.a.x, y: g.b.y }].map(local), width: g.width, layer: g.layer, fill: g.fill, closed: true };
        case 'poly': return { ...g, pts: g.pts.map(local) };
        case 'text': return { ...g, at: local(g.at), rotation: normAngle(g.rotation - rot) };
      }
    };
    const graphics: Graphic[] = [
      ...m.graphics,
      ...m.tracks.map(t => (t.mid ? { type: 'arc' as const, start: t.a, mid: t.mid, end: t.b, width: t.width, layer: t.layer } : { type: 'line' as const, a: t.a, b: t.b, width: t.width, layer: t.layer })),
      ...m.zones.map(z => ({ type: 'poly' as const, pts: z.outline, width: 0, fill: !z.keepout, closed: true, layer: z.keepout ? 'Cmts.User' : z.layer })),
      ...m.texts.filter(t => t.role === 'user').map(t => t.t),
    ].map(lg);
    const ref = cp.SOURCEDESIGNATOR ?? '';
    const pf: PlacedFootprint = {
      ref, value: cp.COMMENT ?? cp.SOURCELIBREFERENCE ?? cp.PATTERN ?? '', at, rotation: rot, side: bottom ? 'bottom' : 'top',
      footprint: { name: cp.PATTERN ?? `FP${i}`, description: cp.FOOTPRINTDESCRIPTION, pads: m.pads.map(p => ({ ...p, at: local(p.at), rotation: normAngle(p.rotation - rot) })), graphics },
      texts: m.texts.filter(t => t.role !== 'user').map(t => ({ ...lg(t.t) as Text, role: t.role, text: t.role === 'reference' ? ref : t.t.text, hidden: t.role === 'reference' ? cp.NAMEON === 'FALSE' : cp.COMMENTON === 'FALSE' })),
      locked: cp.LOCKED === 'TRUE',
    };
    for (const v of m.vias) pf.footprint.pads.push({ number: '', kind: 'thru', shape: 'circle', at: local(v.at), rotation: 0, w: v.size, h: v.size, drill: { w: v.drill, h: v.drill }, side: 'F', net: v.net });
    b.footprints.push(pf);
    r.ok('footprint');
  });
  b.copperLayers = L.copper;
  return b;
}
