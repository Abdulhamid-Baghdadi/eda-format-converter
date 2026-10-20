/**
 * Altium schematic documents (.SchDoc): read-only.
 * All records sit in the FileHeader stream; children point to their component through OwnerIndex.
 * Component graphics and pins are stored already placed on the sheet, so each placed component becomes a
 * symbol definition in its placed orientation (instances are then at rotation 0, unmirrored).
 */
import { readCfb } from './cfb';
import { parseProps } from './pcb';
import type { Graphic, Pin, PinType, Pt, Schematic, Sheet, Symbol, SymbolUnit } from '../model';
import { normAngle, round, rotUp, add } from '../geom';
import { Report } from '../report';

const U = 0.254;
const latin1 = (b: Uint8Array) => { let s = ''; for (const c of b) s += String.fromCharCode(c); return s; };
const c = (p: Record<string, string>, k: string) => ((+(p[k] ?? 0) || 0) + (+(p[`${k}_FRAC`] ?? 0) || 0) / 100000) * U;
/** Altium sheet point (Y up) -> model sheet point (Y down). */
const S = (p: Record<string, string>, x: string, y: string): Pt => ({ x: round(c(p, x), 4), y: round(-c(p, y), 4) });
const ELECTRICAL: Record<string, PinType> = { 0: 'input', 1: 'bidirectional', 2: 'output', 3: 'open_collector', 4: 'passive', 5: 'tri_state', 6: 'open_emitter', 7: 'power_in' };
const WIDTH = [0.1, 0.254, 0.508, 1.016];

export function readAltiumSchDoc(data: Uint8Array, r = new Report(), name = 'schematic'): Schematic {
  const fh = readCfb(data).get('FileHeader');
  if (!fh) throw new Error('Not an Altium schematic');
  const dv = new DataView(fh.buffer, fh.byteOffset, fh.byteLength);
  const recs: Record<string, string>[] = [];
  let o = 0, first = true;
  while (o + 4 <= fh.length) {
    const h = dv.getUint32(o, true), len = h & 0xffffff;
    const body = fh.subarray(o + 4, o + 4 + len); o += 4 + len;
    if (first) { first = false; continue; } // file header record
    recs.push(h >>> 24 ? { RECORD: 'binary' } : parseProps(latin1(body)));
  }
  const kids = new Map<number, number[]>();
  recs.forEach((p, i) => { if (p.OWNERINDEX !== undefined) { const k = +p.OWNERINDEX; kids.set(k, [...(kids.get(k) ?? []), i]); } });
  const sh: Sheet = { name, symbols: [], wires: [], buses: [], junctions: [], noConnects: [], labels: [], graphics: [] };
  const symbols: Record<string, Symbol> = {};
  const defKeys = new Map<string, string>();

  recs.forEach((p, i) => {
    switch (p.RECORD) {
      case '1': {
        const at = S(p, 'LOCATION.X', 'LOCATION.Y');
        const parts = Math.max(1, (+(p.PARTCOUNT ?? 2)) - 1);
        const cur = +(p.CURRENTPARTID ?? 1);
        const units: SymbolUnit[] = Array.from({ length: parts }, () => ({ graphics: [], pins: [] }));
        const rel = (q: Pt): Pt => ({ x: round(q.x - at.x, 4), y: round(-(q.y - at.y), 4) }); // to symbol-local, Y up
        let ref = 'U', value = '', footprint: string | undefined;
        const props: Record<string, string> = {};
        for (const k of kids.get(i) ?? []) {
          const q = recs[k];
          if (+(q.OWNERPARTDISPLAYMODE ?? 0) > 0) continue;
          const part = +(q.OWNERPARTID ?? -1);
          const targets = part >= 1 && part <= parts ? [units[part - 1]] : units;
          if (q.RECORD === '2') {
            const cong = +(q.PINCONGLOMERATE ?? 0);
            const orient = (cong & 3) * 90;
            const len = c(q, 'PINLENGTH');
            const base = S(q, 'LOCATION.X', 'LOCATION.Y');
            const tipUp = add({ x: base.x, y: -base.y }, rotUp({ x: len, y: 0 }, orient));
            const pin: Pin = {
              number: q.DESIGNATOR ?? '', name: (q.NAME ?? '').replace(/\\/g, ''), at: rel({ x: tipUp.x, y: -tipUp.y }), length: round(len, 4), angle: normAngle(orient + 180),
              type: ELECTRICAL[q.ELECTRICAL ?? '4'] ?? 'passive', hidden: (cong & 4) !== 0,
            };
            for (const t of targets) t.pins.push(pin);
            continue;
          }
          if (q.RECORD === '34') { ref = (q.TEXT ?? 'U').replace(/\?+$/, '') || 'U'; continue; }
          if (q.RECORD === '41') { if (/^(Comment|Value)$/i.test(q.NAME ?? '') && q.TEXT && q.TEXT !== '*') value = q.TEXT; else if (q.NAME && q.TEXT && q.TEXT !== '*') props[q.NAME] = q.TEXT; continue; }
          if (q.RECORD === '44') { for (const m of kids.get(k) ?? []) if (recs[m].RECORD === '45' && (recs[m].MODELTYPE ?? '').toUpperCase() === 'PCBLIB' && (!footprint || recs[m].ISCURRENT === 'T')) footprint = recs[m].MODELNAME; continue; }
          const g = graphic(q, rel);
          if (g) for (const t of targets) t.graphics.push(g);
        }
        // the placed part's own geometry decides the definition; identical placements share one
        const def: Symbol = { name: p.LIBREFERENCE ?? 'part', reference: ref.replace(/\d+$/, '') || 'U', value: value || p.LIBREFERENCE, footprint, description: p.COMPONENTDESCRIPTION, properties: {}, units };
        const sig = JSON.stringify([def.name, units]);
        let key = defKeys.get(sig);
        if (!key) { key = `${def.name}#${defKeys.size + 1}`; defKeys.set(sig, key); symbols[key] = def; }
        sh.symbols.push({ ref, value: value || p.LIBREFERENCE || '', footprint, lib: key, unit: Math.min(cur, parts), at, rotation: 0, properties: props });
        r.ok('symbol instance');
        break;
      }
      case '27': case '26': {
        const n = +(p.LOCATIONCOUNT ?? 0);
        for (let k = 1; k < n; k++) (p.RECORD === '27' ? sh.wires : sh.buses).push({ a: S(p, `X${k}`, `Y${k}`), b: S(p, `X${k + 1}`, `Y${k + 1}`) });
        r.ok(p.RECORD === '27' ? 'wire' : 'bus');
        break;
      }
      case '29': sh.junctions.push(S(p, 'LOCATION.X', 'LOCATION.Y')); r.ok('junction'); break;
      case '22': sh.noConnects.push(S(p, 'LOCATION.X', 'LOCATION.Y')); r.ok('no-connect'); break;
      case '25': sh.labels.push({ text: p.TEXT ?? '', at: S(p, 'LOCATION.X', 'LOCATION.Y'), rotation: (+(p.ORIENTATION ?? 0)) * 90, kind: 'local' }); r.ok('label'); break;
      case '17': sh.labels.push({ text: p.TEXT ?? '', at: S(p, 'LOCATION.X', 'LOCATION.Y'), rotation: (+(p.ORIENTATION ?? 0)) * 90, kind: 'global' }); r.ok('power port'); break;
      case '18': {
        // a port connects at both of its ends
        const a = S(p, 'LOCATION.X', 'LOCATION.Y');
        const w = c(p, 'WIDTH');
        const vertical = +(p.STYLE ?? 0) >= 4; // styles 4-7 are the vertical ones
        const b = vertical ? { x: a.x, y: a.y - w } : { x: round(a.x + w, 4), y: a.y };
        sh.labels.push({ text: p.NAME ?? '', at: a, rotation: 0, kind: 'global' }, { text: p.NAME ?? '', at: b, rotation: 0, kind: 'global' });
        r.approx('port', 'sheet ports become global labels');
        break;
      }
      case '4': if (p.OWNERINDEX === undefined && p.TEXT && !p.TEXT.startsWith('=')) { sh.graphics.push({ type: 'text', at: S(p, 'LOCATION.X', 'LOCATION.Y'), text: p.TEXT, size: 1.27, width: 0, rotation: (+(p.ORIENTATION ?? 0)) * 90, layer: 'Notes', justify: 'left' }); r.ok('text'); } break;
      case '15': case '16': r.skip('sheet symbol', 'hierarchical sheet symbols are not converted (convert each .SchDoc; ports connect by name)'); break;
    }
  });
  return { name, symbols, sheets: [sh] };
}

function graphic(q: Record<string, string>, rel: (p: Pt) => Pt): Graphic | null {
  const P = (x: string, y: string) => rel(S(q, x, y));
  const w = WIDTH[+(q.LINEWIDTH ?? 1)] ?? 0.254;
  const solid = q.ISSOLID === 'T';
  switch (q.RECORD) {
    case '13': return { type: 'line', a: P('LOCATION.X', 'LOCATION.Y'), b: P('CORNER.X', 'CORNER.Y'), width: w, layer: 'symbol' };
    case '14': case '10': return { type: 'rect', a: P('LOCATION.X', 'LOCATION.Y'), b: P('CORNER.X', 'CORNER.Y'), width: w, layer: 'symbol', fill: solid };
    case '6': case '7': case '5': {
      const n = +(q.LOCATIONCOUNT ?? 0); const pts: Pt[] = [];
      for (let i = 1; i <= n; i++) pts.push(P(`X${i}`, `Y${i}`));
      return { type: 'poly', pts, width: w, layer: 'symbol', closed: q.RECORD === '7', fill: q.RECORD === '7' && solid };
    }
    case '8': return { type: 'circle', center: P('LOCATION.X', 'LOCATION.Y'), radius: c(q, 'RADIUS'), width: w, layer: 'symbol', fill: solid };
    case '12': case '11': {
      const ctr = P('LOCATION.X', 'LOCATION.Y'), rad = c(q, 'RADIUS');
      const sa = +(q.STARTANGLE ?? 0), ea = +(q.ENDANGLE ?? 360);
      let sw = normAngle(ea - sa); if (sw === 0) sw = 360;
      if (sw >= 359.99) return { type: 'circle', center: ctr, radius: rad, width: w, layer: 'symbol' };
      const at = (a: number) => add(ctr, rotUp({ x: rad, y: 0 }, a));
      return { type: 'arc', start: at(sa), mid: at(sa + sw / 2), end: at(sa + sw), width: w, layer: 'symbol' };
    }
  }
  return null;
}
