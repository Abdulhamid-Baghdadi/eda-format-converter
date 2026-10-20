/**
 * Altium schematic symbol libraries (.SchLib): read-only.
 * One storage per symbol; its Data stream is a list of records, either `|RECORD=n|KEY=VALUE|` text or
 * (for pins) a small binary layout. Units are 10 mil, Y up — the same orientation as the model's symbols.
 */
import { readCfb } from './cfb';
import { parseProps } from './pcb';
import type { Graphic, Pin, PinType, Pt, Symbol, SymbolUnit } from '../model';
import { normAngle, round, rotUp, add } from '../geom';
import { Report } from '../report';

const U = 0.254; // mm per 10 mil
const latin1 = (b: Uint8Array) => { let s = ''; for (const c of b) s += String.fromCharCode(c); return s; };

/** Coordinate with optional _FRAC part (1/100000 of a unit). */
const coord = (p: Record<string, string>, k: string) => round(((+(p[k] ?? 0) || 0) + (+(p[`${k}_FRAC`] ?? 0) || 0) / 100000) * U, 4);
const pt = (p: Record<string, string>, x: string, y: string): Pt => ({ x: coord(p, x), y: coord(p, y) });
const WIDTH = [0.1, 0.254, 0.508, 1.016];
const width = (p: Record<string, string>) => WIDTH[+(p.LINEWIDTH ?? 1)] ?? 0.254;
const solid = (p: Record<string, string>) => p.ISSOLID === 'T';

const ELECTRICAL: Record<number, PinType> = { 0: 'input', 1: 'bidirectional', 2: 'output', 3: 'open_collector', 4: 'passive', 5: 'tri_state', 6: 'open_emitter', 7: 'power_in' };

interface Rec { props: Record<string, string>; pin?: Pin & { part: number; mode: number } }

function readRecords(data: Uint8Array, r: Report): Rec[] {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const out: Rec[] = [];
  let o = 0;
  while (o + 4 <= data.length) {
    const head = dv.getUint32(o, true); o += 4;
    const size = head & 0xffffff, flag = head >>> 24;
    const b = data.subarray(o, o + size); o += size;
    if (flag === 1) { const p = readBinaryPin(b); if (p) out.push({ props: { RECORD: '2' }, pin: p }); else r.skip('binary record', 'unknown binary record'); }
    else out.push({ props: parseProps(latin1(b)) });
  }
  return out;
}

function readBinaryPin(b: Uint8Array): (Pin & { part: number; mode: number }) | null {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let o = 0;
  if (dv.getInt32(0, true) !== 2) return null;
  o = 4;
  o += 1; // unknown
  const part = dv.getInt16(o, true); o += 2;
  const mode = b[o++];
  const inner = b[o++], outer = b[o++]; o += 2; // inside / outside symbols
  const ps = () => { const n = b[o++]; const s = latin1(b.subarray(o, o + n)); o += n; return s; };
  ps(); // description
  o += 1; // formal type
  const electrical = b[o++];
  const cong = b[o++];
  const len = dv.getInt16(o, true); o += 2;
  const x = dv.getInt16(o, true); o += 2;
  const y = dv.getInt16(o, true); o += 2;
  o += 4; // colour
  const name = ps(), number = ps();
  // Altium stores the pin's body end; the electrical end is `length` away in the pin's direction
  const orient = (cong & 3) * 90;
  const base = { x: x * U, y: y * U };
  const tip = add(base, rotUp({ x: len * U, y: 0 }, orient));
  return {
    part, mode, name: name.replace(/\\/g, ''), number, at: { x: round(tip.x, 4), y: round(tip.y, 4) }, length: round(len * U, 4), angle: normAngle(orient + 180),
    type: ELECTRICAL[electrical] ?? 'unspecified', hidden: (cong & 4) !== 0,
    shape: outer === 1 && inner === 3 ? 'inverted_clock' : outer === 1 ? 'inverted' : inner === 3 ? 'clock' : 'line',
  };
}

function graphic(p: Record<string, string>, r: Report): Graphic | null {
  switch (p.RECORD) {
    case '13': return { type: 'line', a: pt(p, 'LOCATION.X', 'LOCATION.Y'), b: pt(p, 'CORNER.X', 'CORNER.Y'), width: width(p), layer: 'symbol' };
    case '14': return { type: 'rect', a: pt(p, 'LOCATION.X', 'LOCATION.Y'), b: pt(p, 'CORNER.X', 'CORNER.Y'), width: width(p), layer: 'symbol', fill: solid(p) };
    case '10': r.approx('rounded rectangle', 'rounded symbol rectangles become plain rectangles');
      return { type: 'rect', a: pt(p, 'LOCATION.X', 'LOCATION.Y'), b: pt(p, 'CORNER.X', 'CORNER.Y'), width: width(p), layer: 'symbol', fill: solid(p) };
    case '6': case '7': case '5': {
      const n = +(p.LOCATIONCOUNT ?? 0);
      const pts: Pt[] = [];
      for (let i = 1; i <= n; i++) pts.push(pt(p, `X${i}`, `Y${i}`));
      if (p.RECORD === '5') r.approx('bezier', 'Bézier curves are approximated by their control polygon');
      return { type: 'poly', pts, width: width(p), layer: 'symbol', closed: p.RECORD === '7', fill: p.RECORD === '7' && solid(p) };
    }
    case '8': {
      const rx = coord(p, 'RADIUS'), ry = coord(p, 'SECONDARYRADIUS') || rx;
      if (Math.abs(rx - ry) > 1e-6) r.approx('ellipse', 'ellipses become circles');
      return { type: 'circle', center: pt(p, 'LOCATION.X', 'LOCATION.Y'), radius: (rx + ry) / 2, width: width(p), layer: 'symbol', fill: solid(p) };
    }
    case '12': case '11': {
      const c = pt(p, 'LOCATION.X', 'LOCATION.Y'), rad = coord(p, 'RADIUS');
      const sa = +(p.STARTANGLE ?? 0), ea = +(p.ENDANGLE ?? 360);
      let sweep = normAngle(ea - sa); if (sweep === 0) sweep = 360;
      if (p.RECORD === '11') r.approx('elliptical arc', 'elliptical arcs become circular arcs');
      if (sweep >= 359.99) return { type: 'circle', center: c, radius: rad, width: width(p), layer: 'symbol' };
      const at = (a: number) => add(c, rotUp({ x: rad, y: 0 }, a));
      return { type: 'arc', start: at(sa), mid: at(sa + sweep / 2), end: at(sa + sweep), width: width(p), layer: 'symbol' };
    }
    case '4': return { type: 'text', at: pt(p, 'LOCATION.X', 'LOCATION.Y'), text: p.TEXT ?? '', size: 1.27, width: 0, rotation: (+(p.ORIENTATION ?? 0)) * 90, layer: 'symbol', justify: 'left' };
  }
  return null;
}

export function readAltiumSchLib(data: Uint8Array, r = new Report()): Symbol[] {
  const s = readCfb(data);
  const storages = [...new Set([...s.keys()].map(k => /^([^/]+)\/Data$/.exec(k)?.[1]).filter((x): x is string => !!x))];
  const out: Symbol[] = [];
  for (const st of storages) {
    const recs = readRecords(s.get(`${st}/Data`)!, r);
    const comp = recs.find(x => x.props.RECORD === '1')?.props;
    if (!comp) continue;
    const parts = Math.max(1, (+(comp.PARTCOUNT ?? 2)) - 1);
    const units: SymbolUnit[] = Array.from({ length: parts }, () => ({ graphics: [], pins: [] }));
    const forUnits = (part: number) => (part >= 1 && part <= parts ? [units[part - 1]] : units);
    let reference = 'U', value: string | undefined, footprint: string | undefined;
    const props: Record<string, string> = {};
    let altDropped = false;
    for (const { props: p, pin } of recs) {
      if (pin) {
        if (pin.mode > 0) { altDropped = true; continue; }
        const { part, mode, ...rest } = pin; void mode;
        for (const u of forUnits(part)) u.pins.push({ ...rest });
        r.ok('pin');
        continue;
      }
      if (+(p.OWNERPARTDISPLAYMODE ?? 0) > 0) { altDropped = true; continue; }
      if (p.RECORD === '34') { reference = (p.TEXT ?? 'U?').replace(/\?+$/, '') || 'U'; continue; }
      if (p.RECORD === '41') {
        const name = p.NAME ?? '';
        if (/^(Comment|Value)$/i.test(name) && p.TEXT && p.TEXT !== '*') value = p.TEXT;
        else if (name && p.TEXT && !/^\*?$/.test(p.TEXT)) props[name] = p.TEXT;
        continue;
      }
      if (p.RECORD === '45' && (p.MODELTYPE ?? '').toUpperCase() === 'PCBLIB' && (!footprint || p.ISCURRENT === 'T')) { footprint = p.MODELNAME; continue; }
      const g = graphic(p, r);
      if (g) { for (const u of forUnits(+(p.OWNERPARTID ?? -1))) u.graphics.push(g); r.ok('symbol graphic'); }
    }
    if (altDropped) r.skip('alternate body style', 'Altium alternate display modes (De Morgan) are dropped');
    const name = comp.LIBREFERENCE ?? st;
    out.push({ name, reference, value: value ?? name, footprint, description: comp.COMPONENTDESCRIPTION || undefined, properties: props, units });
    r.ok('symbol');
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
