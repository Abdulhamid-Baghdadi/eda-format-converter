import { parseSExpr, find, findAll, num, str, val, xy, flag, isList, head, type SList } from './sexpr';
import type { Board, Footprint, Graphic, Pad, PadShape, Pin, PinType, PlacedFootprint, Pt, Symbol, SymbolUnit, Text, Zone, Model3D } from '../model';
import { arcFromCenter, normAngle, rotDown, add } from '../geom';
import { Report } from '../report';

const strokeWidth = (l: SList, d = 0.12) => {
  const s = find(l, 'stroke');
  if (s) return num(val(s, 'width'), d);
  const w = find(l, 'width');
  return w ? num(w[1], d) : d;
};
const isFilled = (l: SList) => {
  const f = find(l, 'fill');
  if (!f) return false;
  const t = find(f, 'type');
  const v = str(t ? t[1] : f[1]);
  return v === 'yes' || v === 'solid' || v === 'outline' || v === 'background';
};

function pts(l: SList | undefined, r: Report): Pt[] {
  if (!l) return [];
  const out: Pt[] = [];
  for (const e of l.slice(1)) {
    if (!isList(e)) continue;
    if (head(e) === 'xy') out.push(xy(e));
    else if (head(e) === 'arc') { out.push(xy(find(e, 'start')), xy(find(e, 'mid')), xy(find(e, 'end'))); r.approx('polygon arc segment', 'arc inside polygon kept as straight segments through its mid point'); }
  }
  return out;
}

function readText(e: SList, at: SList | undefined, text: string, layer: string, role: Text['role']): Text {
  const eff = find(e, 'effects');
  const font = eff && find(eff, 'font');
  const size = font ? num(find(font, 'size')?.[1], 1) : 1;
  const thick = font ? num(val(font, 'thickness'), size * 0.15) : size * 0.15;
  const just = eff && find(eff, 'justify');
  const js = just ? just.slice(1).map(String) : [];
  return {
    type: 'text', at: xy(at), rotation: num(at?.[3]), text, size, width: thick, layer, role,
    mirror: js.includes('mirror'), hidden: flag(e, 'hide') || (eff ? flag(eff, 'hide') : false),
    justify: js.includes('left') ? 'left' : js.includes('right') ? 'right' : 'center',
  };
}

/** Parse one graphic item. `prefix` is 'fp_', 'gr_' or '' (symbols). */
export function readGraphic(e: SList, prefix: string, r: Report, defaultLayer = 'F.SilkS'): Graphic | null {
  const h = head(e)!;
  if (!h.startsWith(prefix)) return null;
  const t = h.slice(prefix.length);
  const layer = str(val(e, 'layer')) ?? defaultLayer;
  const width = strokeWidth(e);
  const fill = isFilled(e);
  switch (t) {
    case 'line': return { type: 'line', a: xy(find(e, 'start')), b: xy(find(e, 'end')), width, layer };
    case 'rect': case 'rectangle': return { type: 'rect', a: xy(find(e, 'start')), b: xy(find(e, 'end')), width, layer, fill };
    case 'circle': {
      const c = xy(find(e, 'center'));
      const rad = find(e, 'radius');
      const radius = rad ? num(rad[1]) : Math.hypot(xy(find(e, 'end')).x - c.x, xy(find(e, 'end')).y - c.y);
      return { type: 'circle', center: c, radius, width, layer, fill };
    }
    case 'arc': {
      const mid = find(e, 'mid');
      if (mid) return { type: 'arc', start: xy(find(e, 'start')), mid: xy(mid), end: xy(find(e, 'end')), width, layer };
      // KiCad 5: (start = centre) (end = arc start) (angle)
      const a = arcFromCenter(xy(find(e, 'start')), xy(find(e, 'end')), num(val(e, 'angle')), true);
      return { type: 'arc', ...a, width, layer };
    }
    case 'poly': case 'polyline': {
      const p = pts(find(e, 'pts'), r);
      return { type: 'poly', pts: p, width, layer, fill, closed: prefix !== '' || (p.length > 2 && p[0].x === p[p.length - 1].x && p[0].y === p[p.length - 1].y) };
    }
    case 'curve': case 'bezier': {
      r.approx('bezier curve', 'Bézier curves are approximated by their control polygon');
      return { type: 'poly', pts: pts(find(e, 'pts'), r), width, layer, closed: false };
    }
    case 'text': {
      if (prefix === 'fp_') {
        const kind = str(e[1]);
        return readText(e, find(e, 'at'), str(e[2]) ?? '', layer, kind === 'reference' ? 'reference' : kind === 'value' ? 'value' : 'user');
      }
      return readText(e, find(e, 'at'), str(e[1]) ?? '', layer, 'user');
    }
    case 'text_box': case 'textbox': {
      r.approx('text box', 'text boxes become plain text');
      const s = xy(find(e, 'start'));
      return { ...readText(e, find(e, 'at') ?? ['at', s.x, s.y], str(e[1]) ?? '', layer, 'user') };
    }
    case 'dimension': r.skip('dimension', 'dimensions are not converted'); return null;
    case 'image': r.skip('image', 'bitmap images are not converted'); return null;
  }
  return null;
}

const padShapeMap: Record<string, PadShape> = { circle: 'circle', rect: 'rect', oval: 'oval', roundrect: 'roundrect', custom: 'custom', trapezoid: 'rect' };

function readPad(e: SList, fpRot: number, r: Report): Pad {
  const at = find(e, 'at');
  const kindTok = str(e[2]);
  const shapeTok = str(e[3]) ?? 'rect';
  const layers = (find(e, 'layers') ?? []).slice(1).map(String);
  const size = find(e, 'size');
  const pad: Pad = {
    number: str(e[1]) ?? '',
    kind: kindTok === 'smd' || kindTok === 'connect' ? 'smd' : kindTok === 'np_thru_hole' ? 'npth' : 'thru',
    shape: padShapeMap[shapeTok] ?? 'rect',
    at: xy(at), rotation: normAngle(num(at?.[3]) - fpRot),
    w: num(size?.[1]), h: num(size?.[2]),
    side: layers.includes('B.Cu') && !layers.includes('F.Cu') && !layers.some(l => l.startsWith('*')) ? 'B' : 'F',
  };
  if (shapeTok === 'trapezoid') r.approx('trapezoid pad', 'trapezoid pads become rectangles');
  if (kindTok === 'connect') r.approx('connector pad', 'edge-connector pads become SMD pads');
  if (pad.shape === 'roundrect') pad.roundRatio = num(val(e, 'roundrect_rratio'), 0.25);
  const ch = find(e, 'chamfer');
  if (find(e, 'chamfer_ratio') && ch && ch.length > 1) {
    const ratio = num(val(e, 'chamfer_ratio'));
    if (ch.length === 5 && Math.abs(ratio - 0.2929) < 0.01 && Math.abs(pad.w - pad.h) < 1e-6) { pad.shape = 'octagon'; delete pad.roundRatio; }
    else r.approx('chamfered pad', 'chamfered corners are dropped');
  }
  const drill = find(e, 'drill');
  if (drill) {
    const oval = str(drill[1]) === 'oval';
    const a = num(drill[oval ? 2 : 1]);
    const b = oval ? num(drill[3], a) : a;
    if (a > 0) pad.drill = { w: a, h: b };
  }
  if (pad.kind === 'smd') {
    const sideP = pad.side === 'F' ? 'F.' : 'B.';
    pad.noPaste = !layers.some(l => l === sideP + 'Paste' || l === '*.Paste');
    pad.noMask = !layers.some(l => l === sideP + 'Mask' || l === '*.Mask');
  }
  const net = find(e, 'net');
  if (net) pad.net = net.length > 2 ? str(net[2]) : str(net[1]);
  if (pad.shape === 'custom') {
    const prims = find(e, 'primitives');
    const poly = prims && find(prims, 'gr_poly');
    if (poly) {
      pad.anchor = Math.min(pad.w, pad.h);
      pad.poly = pts(find(poly, 'pts'), r);
      // model convention: w/h of a custom pad is the extent of its outline (and anchor)
      const xs = pad.poly.map(p => Math.abs(p.x)), ys = pad.poly.map(p => Math.abs(p.y));
      pad.w = Math.max(pad.w, 2 * Math.max(...xs)); pad.h = Math.max(pad.h, 2 * Math.max(...ys));
    }
    else r.approx('custom pad', 'custom pad without polygon primitive kept as its anchor shape');
    if (prims && prims.length > 2) r.approx('custom pad', 'only the first primitive of custom pads is kept');
  }
  return pad;
}

function readModel(e: SList): Model3D {
  const v3 = (n: string, d = 0): [number, number, number] => { const x = find(find(e, n) ?? [], 'xyz'); return [num(x?.[1], d), num(x?.[2], d), num(x?.[3], d)]; };
  const offset = find(e, 'offset') ? v3('offset') : v3('at').map(v => v * 25.4) as [number, number, number];
  return { path: str(e[1]) ?? '', offset, rotation: v3('rotate'), scale: v3('scale', 1) };
}

export function readFootprintList(e: SList, r: Report, fpRot = 0): { fp: Footprint; texts: Text[] } {
  const fp: Footprint = { name: str(e[1]) ?? 'footprint', pads: [], graphics: [] };
  const texts: Text[] = [];
  for (const c of e) {
    if (!isList(c)) continue;
    const h = head(c)!;
    if (h === 'descr') fp.description = str(c[1]);
    else if (h === 'pad') { fp.pads.push(readPad(c, fpRot, r)); r.ok('pad'); }
    else if (h === 'model') { (fp.model3d ??= []).push(readModel(c)); r.ok('3D model reference'); }
    else if (h === 'property') {
      const name = str(c[1]);
      if ((name === 'Reference' || name === 'Value') && find(c, 'at')) {
        const t = readText(c, find(c, 'at'), str(c[2]) ?? '', str(val(c, 'layer')) ?? 'F.SilkS', name === 'Reference' ? 'reference' : 'value');
        texts.push(t);
      }
    } else if (h.startsWith('fp_')) {
      const g = readGraphic(c, 'fp_', r);
      if (g) {
        if (g.type === 'text' && g.role !== 'user') texts.push(g);
        else { fp.graphics.push(g); r.ok(g.type === 'text' ? 'text' : 'graphic'); }
      } else if (!['fp_text'].includes(h)) r.skip(h, 'not supported');
    } else if (h === 'zone') r.skip('footprint zone', 'zones inside footprints are not converted');
    else if (h === 'group') r.skip('group', 'groups are flattened');
  }
  // keep reference/value labels as user-visible graphics on stand-alone footprints
  return { fp, texts };
}

export function readKicadFootprint(src: string, r = new Report()): Footprint {
  const root = parseSExpr(src)[0] as SList;
  if (!root || !['footprint', 'module'].includes(head(root)!)) throw new Error('Not a KiCad footprint (.kicad_mod)');
  const { fp, texts } = readFootprintList(root, r);
  for (const t of texts) fp.graphics.push(t);
  fp.name = fp.name.replace(/^.*:/, '');
  return fp;
}

const pinTypes: Record<string, PinType> = {
  input: 'input', output: 'output', bidirectional: 'bidirectional', tri_state: 'tri_state', passive: 'passive',
  power_in: 'power_in', power_out: 'power_out', open_collector: 'open_collector', open_emitter: 'open_emitter',
  unspecified: 'unspecified', no_connect: 'no_connect', free: 'unspecified',
};

function readPin(e: SList): Pin {
  const at = find(e, 'at');
  const name = find(e, 'name'), number = find(e, 'number');
  const style = str(e[2]) ?? 'line';
  return {
    type: pinTypes[str(e[1]) ?? ''] ?? 'unspecified',
    shape: style === 'inverted' ? 'inverted' : style === 'clock' ? 'clock' : style === 'inverted_clock' ? 'inverted_clock' : 'line',
    at: xy(at), angle: num(at?.[3]), length: num(val(e, 'length'), 2.54),
    name: str(name?.[1]) ?? '', number: str(number?.[1]) ?? '', hidden: flag(e, 'hide'),
  };
}

export function readKicadSymbols(src: string, r = new Report()): Symbol[] {
  const root = parseSExpr(src)[0] as SList;
  if (head(root) !== 'kicad_symbol_lib') throw new Error('Not a KiCad symbol library (.kicad_sym)');
  const byName = new Map<string, SList>();
  for (const s of findAll(root, 'symbol')) byName.set(str(s[1])!, s);
  const out: Symbol[] = [];
  for (const s of findAll(root, 'symbol')) out.push(readSymbolList(s, byName, r));
  return out;
}

export function readSymbolList(s: SList, byName: Map<string, SList>, r: Report): Symbol {
  const name = str(s[1])!;
  const props: Record<string, string> = {};
  for (const p of findAll(s, 'property')) props[str(p[1])!] = str(p[2]) ?? '';
  const ext = str(val(s, 'extends'));
  const geomSrc = ext && byName.get(ext) ? byName.get(ext)! : s;
  const units = new Map<number, SymbolUnit>();
  const common: SymbolUnit = { graphics: [], pins: [] };
  for (const sub of findAll(geomSrc, 'symbol')) {
    const m = /_(\d+)_(\d+)$/.exec(str(sub[1])!);
    const u = m ? +m[1] : 1, style = m ? +m[2] : 1;
    if (style > 1) { r.skip('alternate body style', 'De Morgan alternate body styles are dropped'); continue; }
    const tgt = u === 0 ? common : (units.get(u) ?? (units.set(u, { graphics: [], pins: [] }), units.get(u)!));
    for (const c of sub) {
      if (!isList(c)) continue;
      if (head(c) === 'pin') { tgt.pins.push(readPin(c)); r.ok('pin'); continue; }
      const g = readGraphic(c, '', r, 'symbol');
      if (g?.type === 'text') g.rotation = normAngle(g.rotation / 10); // tenths of a degree in symbol libs
      if (g) { tgt.graphics.push(g); r.ok('symbol graphic'); }
    }
  }
  const list = [...units.entries()].sort((a, b) => a[0] - b[0]).map(e => e[1]);
  if (!list.length) list.push({ graphics: [], pins: [] });
  for (const u of list) { u.graphics.unshift(...common.graphics); u.pins.unshift(...common.pins); }
  r.ok('symbol');
  const { Reference, Value, Footprint: fpn, Datasheet, Description, ...rest } = props;
  delete (rest as Record<string, string>)['ki_description'];
  return {
    name, reference: (Reference ?? 'U').replace(/\?$/, ''), value: Value, footprint: fpn || undefined,
    datasheet: Datasheet && Datasheet !== '~' ? Datasheet : undefined,
    description: Description ?? props['ki_description'], properties: rest, units: list, power: flag(s, 'power'),
  };
}

export function readKicadPcb(src: string, r = new Report(), name = 'board'): Board {
  const root = parseSExpr(src)[0] as SList;
  if (head(root) !== 'kicad_pcb') throw new Error('Not a KiCad board (.kicad_pcb)');
  const netNames = new Map<number, string>();
  for (const n of findAll(root, 'net')) netNames.set(num(n[1]), str(n[2]) ?? '');
  const netOf = (e: SList) => {
    const n = find(e, 'net');
    if (!n) return undefined;
    const v = n[1];
    const s = typeof v === 'number' ? netNames.get(v) : str(v);
    return s || undefined;
  };
  const layers = find(root, 'layers');
  const copper = layers ? layers.slice(1).filter(l => isList(l) && /\.Cu$/.test(str(l[1])!)).length : 2;
  const b: Board = { name, copperLayers: copper || 2, footprints: [], tracks: [], vias: [], zones: [], graphics: [], holes: [], nets: [...netNames.values()].filter(Boolean) };
  for (const c of root) {
    if (!isList(c)) continue;
    const h = head(c)!;
    if (h === 'footprint' || h === 'module') {
      const at = find(c, 'at');
      const rot = num(at?.[3]);
      const { fp, texts } = readFootprintList(c, r, rot);
      for (const p of fp.pads) {
        // pad nets live on the pad; collect them
        if (p.net && !b.nets.includes(p.net)) b.nets.push(p.net);
      }
      const props: Record<string, string> = {};
      for (const p of findAll(c, 'property')) props[str(p[1])!] = str(p[2]) ?? '';
      const ref = props.Reference ?? texts.find(t => t.role === 'reference')?.text ?? '';
      const value = props.Value ?? texts.find(t => t.role === 'value')?.text ?? '';
      // property/fp_text rotations are absolute in KiCad; store them relative to the footprint
      for (const t of texts) t.rotation = normAngle(t.rotation - rot);
      // plain mounting holes (how board-level holes from other tools are written) come back as holes
      if (fp.pads.length === 1 && fp.pads[0].kind === 'npth' && !fp.graphics.length && /^(MountingHole|Hole)$/.test(fp.name.replace(/^.*:/, '')) && !fp.model3d) {
        b.holes.push({ at: placeDown({ at: xy(at), rotation: rot }, fp.pads[0].at), d: fp.pads[0].drill?.w ?? fp.pads[0].w });
        r.ok('hole');
        continue;
      }
      const pf: PlacedFootprint = {
        ref, value, at: xy(at), rotation: rot, side: str(val(c, 'layer')) === 'B.Cu' ? 'bottom' : 'top',
        footprint: { ...fp, name: fp.name.replace(/^.*:/, '') }, texts, locked: flag(c, 'locked'),
      };
      b.footprints.push(pf);
      r.ok('footprint');
    } else if (h === 'segment' || h === 'arc') {
      b.tracks.push({ layer: str(val(c, 'layer')) ?? 'F.Cu', width: num(val(c, 'width'), 0.25), a: xy(find(c, 'start')), b: xy(find(c, 'end')), mid: h === 'arc' ? xy(find(c, 'mid')) : undefined, net: netOf(c) });
      r.ok(h === 'arc' ? 'track arc' : 'track');
    } else if (h === 'via') {
      const ls = (find(c, 'layers') ?? []).slice(1).map(String);
      b.vias.push({ at: xy(find(c, 'at')), size: num(val(c, 'size'), 0.6), drill: num(val(c, 'drill'), 0.3), net: netOf(c), from: ls[0], to: ls[1] });
      if (str(c[1]) === 'blind' || str(c[1]) === 'micro') r.approx('via', 'blind/micro via type is kept as layer pair only');
      r.ok('via');
    } else if (h === 'zone') {
      const lay = find(c, 'layers') ? find(c, 'layers')!.slice(1).map(String) : [str(val(c, 'layer')) ?? 'F.Cu'];
      const keepout = !!find(c, 'keepout');
      const net = str(val(c, 'net_name')) || netOf(c);
      for (const poly of findAll(c, 'polygon')) {
        for (const l of lay) {
          for (const ll of l.startsWith('*') ? ['F.Cu', 'B.Cu'] : [l]) {
            const z: Zone = { layer: ll, net: net || undefined, outline: pts(find(poly, 'pts'), r), keepout, priority: num(val(c, 'priority')) };
            const cp = find(c, 'connect_pads');
            if (cp) z.clearance = num(val(cp, 'clearance'));
            z.minWidth = num(val(c, 'min_thickness'), 0.25);
            b.zones.push(z);
          }
        }
      }
      r.ok(keepout ? 'keepout area' : 'zone');
    } else if (h.startsWith('gr_')) {
      const g = readGraphic(c, 'gr_', r);
      if (g) { b.graphics.push(g); r.ok(g.layer === 'Edge.Cuts' ? 'board outline segment' : 'board graphic'); }
    } else if (h === 'dimension') r.skip('dimension', 'dimensions are not converted');
    else if (h === 'image') r.skip('image', 'bitmap images are not converted');
  }
  return b;
}

/** World position of a footprint-local point. */
export const placeDown = (pf: { at: Pt; rotation: number }, p: Pt) => add(pf.at, rotDown(p, pf.rotation));
