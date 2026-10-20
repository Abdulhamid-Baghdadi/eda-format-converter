import { q, writeSExpr, type W } from './sexpr';
import type { Board, Footprint, Graphic, Pad, Pin, Symbol, Text } from '../model';
import { normAngle, footprintBBox } from '../geom';
import { Report } from '../report';

/** Output targets the KiCad 8 file format, which KiCad 8, 9 and 10 all open natively. */
export const GENERATOR = 'eda_format_converter';
const VERSION_PCB = 20240108;
const VERSION_SYM = 20231120;

const pt = (n: string, p: { x: number; y: number }): W => [n, p.x, p.y];
const stroke = (w: number): W => ['stroke', ['width', w], ['type', 'solid']];
export const effects = (t: { size: number; width?: number; mirror?: boolean; justify?: string; hidden?: boolean }): W => {
  const just: (string)[] = [];
  if (t.justify && t.justify !== 'center') just.push(t.justify);
  if (t.mirror) just.push('mirror');
  return ['effects', ['font', ['size', t.size, t.size], t.width ? ['thickness', t.width] : null], just.length ? ['justify', ...just] : null, t.hidden ? ['hide', 'yes'] : null];
};

/** KiCad layer names a graphic may legally sit on in a footprint/board; anything else lands on Cmts.User. */
const KNOWN = new Set(['F.Cu', 'B.Cu', 'F.SilkS', 'B.SilkS', 'F.Mask', 'B.Mask', 'F.Paste', 'B.Paste', 'F.Fab', 'B.Fab', 'F.CrtYd', 'B.CrtYd',
  'Edge.Cuts', 'Dwgs.User', 'Cmts.User', 'Eco1.User', 'Eco2.User', 'Margin', 'F.Adhes', 'B.Adhes', ...Array.from({ length: 30 }, (_, i) => `In${i + 1}.Cu`)]);
const lay = (l: string) => (KNOWN.has(l) ? l : 'Cmts.User');

export function graphicSExpr(g: Graphic, prefix: 'fp_' | 'gr_', textRot = 0): W | null {
  const layer: W = ['layer', q(lay(g.layer))];
  const fill: W = ['fill', g.fill ? 'solid' : 'none'];
  switch (g.type) {
    case 'line': return [prefix + 'line', pt('start', g.a), pt('end', g.b), stroke(g.width), layer];
    case 'arc': return [prefix + 'arc', pt('start', g.start), pt('mid', g.mid), pt('end', g.end), stroke(g.width), layer];
    case 'circle': return [prefix + 'circle', pt('center', g.center), ['end', g.center.x + g.radius, g.center.y], stroke(g.width), fill, layer];
    case 'rect': return [prefix + 'rect', pt('start', g.a), pt('end', g.b), stroke(g.width), fill, layer];
    case 'poly':
      if (!g.closed) {
        // open polylines become line segments (KiCad polygons are always closed)
        return ['__multi', ...g.pts.slice(1).map((p, i) => [prefix + 'line', pt('start', g.pts[i]), pt('end', p), stroke(g.width), layer] as W)];
      }
      return [prefix + 'poly', ['pts', ...g.pts.map(p => pt('xy', p))], stroke(g.width), fill, layer];
    case 'text': {
      if (prefix === 'fp_') return ['fp_text', 'user', q(g.text), ['at', g.at.x, g.at.y, normAngle(g.rotation + textRot) || null], layer, effects(g)];
      return ['gr_text', q(g.text), ['at', g.at.x, g.at.y, normAngle(g.rotation) || null], layer, effects(g)];
    }
  }
}
const push = (out: W, e: W | null) => { if (!e) return; if (e[0] === '__multi') out.push(...(e.slice(1) as W[])); else out.push(e); };

function padSExpr(p: Pad, fpRot: number, netIndex?: Map<string, number>): W {
  const kind = p.kind === 'smd' ? 'smd' : p.kind === 'npth' ? 'np_thru_hole' : 'thru_hole';
  let shape: string = p.shape;
  // KiCad has no octagon: a rectangle with all four corners chamfered by 1-1/√2 is exactly one
  const octagon = shape === 'octagon';
  if (octagon) shape = 'roundrect';
  if (p.shape === 'custom' && !p.poly?.length) shape = 'rect';
  const layers = p.kind === 'smd'
    ? [p.side + '.Cu', p.noPaste ? null : p.side + '.Paste', p.noMask ? null : p.side + '.Mask'].filter(Boolean).map(s => q(s!))
    : p.kind === 'npth' ? [q('*.Cu'), q('*.Mask')] : [q('*.Cu'), q('*.Mask')];
  const e: W = ['pad', q(p.number), kind, shape, ['at', p.at.x, p.at.y, normAngle(p.rotation + fpRot) || null]];
  // custom pads: a small round anchor plus the outline polygon (w/h in the model are the outline's extent)
  if (shape === 'custom') { const a = p.anchor ?? Math.max(0.05, Math.min(p.w, p.h) * 0.5); e.push(['size', a, a]); }
  else e.push(['size', p.w, p.h]);
  if (p.drill) e.push(p.drill.w !== p.drill.h ? ['drill', 'oval', p.drill.w, p.drill.h] : ['drill', p.drill.w]);
  e.push(['layers', ...layers]);
  if (octagon) e.push(['roundrect_rratio', 0], ['chamfer_ratio', 0.292893], ['chamfer', 'top_left', 'top_right', 'bottom_left', 'bottom_right']);
  else if (shape === 'roundrect') e.push(['roundrect_rratio', Math.min(0.5, p.roundRatio ?? 0.25)]);
  if (p.net && netIndex?.has(p.net)) e.push(['net', netIndex.get(p.net)!, q(p.net)]);
  if (shape === 'custom') {
    e.push(['options', ['clearance', 'outline'], ['anchor', 'circle']]);
    e.push(['primitives', ['gr_poly', ['pts', ...p.poly!.map(v => pt('xy', v))], ['width', 0], ['fill', 'yes']]]);
  }
  return e;
}

function fpBody(fp: Footprint, opts: { rot?: number; netIndex?: Map<string, number>; ref?: string; value?: string; texts?: Text[]; layer?: string }): W[] {
  const out: W[] = [];
  const rot = opts.rot ?? 0;
  const bb = footprintBBox(fp);
  const bottom = opts.layer === 'B.Cu';
  const refT = opts.texts?.find(t => t.role === 'reference');
  const valT = opts.texts?.find(t => t.role === 'value');
  const prop = (name: string, v: string, t: Text | undefined, defY: number, defLayer: string): W => [
    'property', q(name), q(v), ['at', t?.at.x ?? 0, t?.at.y ?? defY, normAngle((t?.rotation ?? 0) + rot) || null],
    ['layer', q(lay(t?.layer ?? defLayer))], t?.hidden ? ['hide', 'yes'] : null,
    effects({ size: t?.size ?? 1, width: t?.width ?? 0.15, mirror: t?.mirror ?? bottom })];
  out.push(prop('Reference', opts.ref ?? 'REF**', refT, bb.y0 - 1.2, bottom ? 'B.SilkS' : 'F.SilkS'));
  out.push(prop('Value', opts.value ?? fp.name, valT, bb.y1 + 1.2, bottom ? 'B.Fab' : 'F.Fab'));
  if (fp.description) out.push(['property', q('Description'), q(fp.description), ['at', 0, 0, null], ['layer', q('F.Fab')], ['hide', 'yes'], effects({ size: 1, width: 0.15 })]);
  const tht = fp.pads.some(p => p.kind === 'thru');
  out.push(['attr', tht ? 'through_hole' : fp.pads.length ? 'smd' : 'board_only']);
  for (const g of fp.graphics) push(out, graphicSExpr(g, 'fp_', rot));
  for (const p of fp.pads) out.push(padSExpr(p, rot, opts.netIndex));
  for (const h of fp.holes ?? []) out.push(padSExpr({ number: '', kind: 'npth', shape: 'circle', at: h.at, rotation: 0, w: h.d, h: h.d, drill: { w: h.d, h: h.d }, side: 'F' }, rot));
  for (const m of fp.model3d ?? []) out.push(['model', q(m.path), ['offset', ['xyz', ...m.offset]], ['scale', ['xyz', ...(m.scale ?? [1, 1, 1])]], ['rotate', ['xyz', ...m.rotation]]]);
  return out;
}

export const kicadName = (s: string) => s.replace(/[:/\\<>"|?*]/g, '_').trim() || 'unnamed';

export function writeKicadFootprint(fp: Footprint, r = new Report()): string {
  r.ok('footprint');
  const e: W = ['footprint', q(kicadName(fp.name)), ['version', VERSION_PCB], ['generator', q(GENERATOR)], ['layer', q('F.Cu')], ...fpBody(fp, {})];
  return writeSExpr(e) + '\n';
}

const pinStyle: Record<string, string> = { line: 'line', inverted: 'inverted', clock: 'clock', inverted_clock: 'inverted_clock' };

function pinSExpr(p: Pin): W {
  return ['pin', p.type, pinStyle[p.shape ?? 'line'], ['at', p.at.x, p.at.y, normAngle(p.angle)], ['length', p.length], p.hidden ? ['hide', 'yes'] : null,
    ['name', q(p.name || '~'), effects({ size: 1.27 })], ['number', q(p.number), effects({ size: 1.27 })]];
}

function symGraphic(g: Graphic): W | null {
  const st: W = ['stroke', ['width', g.width || 0], ['type', 'default']];
  const fill: W = ['fill', ['type', g.fill ? 'background' : 'none']];
  switch (g.type) {
    case 'line': return ['polyline', ['pts', pt('xy', g.a), pt('xy', g.b)], st, fill];
    case 'poly': return ['polyline', ['pts', ...(g.closed && g.pts.length ? [...g.pts, g.pts[0]] : g.pts).map(p => pt('xy', p))], st, fill];
    case 'rect': return ['rectangle', pt('start', g.a), pt('end', g.b), st, fill];
    case 'circle': return ['circle', pt('center', g.center), ['radius', g.radius], st, fill];
    case 'arc': return ['arc', pt('start', g.start), pt('mid', g.mid), pt('end', g.end), st, fill];
    case 'text': return ['text', q(g.text), ['at', g.at.x, g.at.y, normAngle(g.rotation) * 10 /* symbol text angles are stored in tenths of a degree */], effects({ size: g.size, justify: g.justify })];
  }
}

/** One symbol definition as an S-expression (`name` may be "lib:name" inside a schematic's lib_symbols). */
export function symbolSExpr(s: Symbol, name: string): W {
  const base = name.replace(/^.*:/, '');
  const ys = s.units.flatMap(u => [...u.pins.map(p => p.at.y), ...u.graphics.flatMap(g => g.type === 'rect' ? [g.a.y, g.b.y] : g.type === 'poly' ? g.pts.map(p => p.y) : [])]);
  const top = ys.length ? Math.max(...ys) : 0, bot = ys.length ? Math.min(...ys) : 0;
  const prop = (k: string, v: string, y: number, hide = false): W => ['property', q(k), q(v), ['at', 0, y, 0], effects({ size: 1.27, hidden: hide })];
  const e: W = ['symbol', q(name)];
  if (s.power) e.push(['power']);
  e.push(['pin_names', ['offset', 0.508]], ['exclude_from_sim', 'no'], ['in_bom', s.power ? 'no' : 'yes'], ['on_board', s.power ? 'no' : 'yes']);
  e.push(prop('Reference', s.reference || 'U', top + 2.54, !!s.power));
  e.push(prop('Value', s.value ?? s.name, bot - 2.54));
  e.push(prop('Footprint', s.footprint ?? '', bot - 5.08, true));
  e.push(prop('Datasheet', s.datasheet ?? '', bot - 7.62, true));
  e.push(prop('Description', s.description ?? '', bot - 10.16, true));
  for (const [k, v] of Object.entries(s.properties)) if (k && !/^(Reference|Value|Footprint|Datasheet|Description)$/.test(k)) e.push(prop(k, v, 0, true));
  s.units.forEach((u, i) => {
    const body: W = ['symbol', q(`${base}_${i + 1}_1`)];
    for (const g of u.graphics) { const x = symGraphic(g); if (x) body.push(x); }
    for (const p of u.pins) body.push(pinSExpr(p));
    e.push(body);
  });
  return e;
}

export function writeKicadSymbols(symbols: Symbol[], r = new Report()): string {
  const used = new Set<string>();
  const lib: W = ['kicad_symbol_lib', ['version', VERSION_SYM], ['generator', q(GENERATOR)]];
  for (const s of symbols) {
    let name = kicadName(s.name);
    while (used.has(name)) name += '_';
    used.add(name);
    lib.push(symbolSExpr(s, name));
    r.ok('symbol');
    r.ok('pin', s.units.flatMap(u => u.pins).length);
  }
  return writeSExpr(lib) + '\n';
}

// KiCad 8 numeric layer ids
const LAYER_IDS: [number, string, string][] = [
  [0, 'F.Cu', 'signal'], [31, 'B.Cu', 'signal'], [32, 'B.Adhes', 'user'], [33, 'F.Adhes', 'user'], [34, 'B.Paste', 'user'], [35, 'F.Paste', 'user'],
  [36, 'B.SilkS', 'user'], [37, 'F.SilkS', 'user'], [38, 'B.Mask', 'user'], [39, 'F.Mask', 'user'], [40, 'Dwgs.User', 'user'], [41, 'Cmts.User', 'user'],
  [42, 'Eco1.User', 'user'], [43, 'Eco2.User', 'user'], [44, 'Edge.Cuts', 'user'], [45, 'Margin', 'user'], [46, 'B.CrtYd', 'user'], [47, 'F.CrtYd', 'user'],
  [48, 'B.Fab', 'user'], [49, 'F.Fab', 'user'],
];

export function writeKicadPcb(b: Board, r = new Report()): string {
  const inner = Math.max(0, Math.min(30, (b.copperLayers || 2) - 2));
  const layers: W = ['layers', ['0', q('F.Cu'), 'signal']];
  for (let i = 1; i <= inner; i++) layers.push([String(i), q(`In${i}.Cu`), 'signal']);
  for (const [id, n, t] of LAYER_IDS.slice(1)) layers.push([String(id), q(n), t]);
  const copperOk = (l: string) => l === 'F.Cu' || l === 'B.Cu' || (/^In(\d+)\.Cu$/.test(l) && +/^In(\d+)/.exec(l)![1] <= inner);
  const cu = (l: string) => { if (copperOk(l)) return l; r.approx('copper layer', `layer ${l} moved to B.Cu (board has ${inner + 2} copper layers)`); return 'B.Cu'; };

  const nets = [...new Set([...b.nets, ...b.tracks.map(t => t.net), ...b.vias.map(v => v.net), ...b.zones.map(z => z.net), ...b.footprints.flatMap(f => f.footprint.pads.map(p => p.net))].filter((n): n is string => !!n))];
  const netIndex = new Map(nets.map((n, i) => [n, i + 1]));
  const netRef = (n?: string): W | null => (n && netIndex.has(n) ? ['net', netIndex.get(n)!] : null);

  const e: W = ['kicad_pcb', ['version', VERSION_PCB], ['generator', q(GENERATOR)], ['generator_version', q('1.0')],
    ['general', ['thickness', 1.6], ['legacy_teardrops', 'no']], ['paper', q('A4')], layers,
    ['setup', ['pad_to_mask_clearance', 0]], ['net', 0, q('')], ...nets.map(n => ['net', netIndex.get(n)!, q(n)] as W)];

  for (const f of b.footprints) {
    const body = fpBody({ ...f.footprint, pads: f.footprint.pads.map(p => ({ ...p })) }, { rot: f.rotation, netIndex, ref: f.ref, value: f.value, texts: f.texts, layer: f.side === 'bottom' ? 'B.Cu' : 'F.Cu' });
    e.push(['footprint', q(kicadName(f.footprint.name)), f.locked ? ['locked', 'yes'] : null, ['layer', q(f.side === 'bottom' ? 'B.Cu' : 'F.Cu')], ['at', f.at.x, f.at.y, normAngle(f.rotation) || null], ...body]);
    r.ok('footprint');
  }
  for (const g of b.graphics) { push(e, graphicSExpr(g, 'gr_')); }
  r.ok('board graphic', b.graphics.length);
  for (const t of b.tracks) {
    e.push(t.mid
      ? ['arc', pt('start', t.a), pt('mid', t.mid), pt('end', t.b), ['width', t.width], ['layer', q(cu(t.layer))], netRef(t.net)]
      : ['segment', pt('start', t.a), pt('end', t.b), ['width', t.width], ['layer', q(cu(t.layer))], netRef(t.net)]);
  }
  r.ok('track', b.tracks.length);
  for (const v of b.vias) {
    const from = v.from && copperOk(v.from) ? v.from : 'F.Cu', to = v.to && copperOk(v.to) ? v.to : 'B.Cu';
    const blind = !(from === 'F.Cu' && to === 'B.Cu') && !(from === 'B.Cu' && to === 'F.Cu');
    e.push(['via', blind ? 'blind' : null, pt('at', v.at), ['size', v.size], ['drill', v.drill], ['layers', q(from), q(to)], netRef(v.net)]);
  }
  r.ok('via', b.vias.length);
  for (const h of b.holes) {
    e.push(['footprint', q('MountingHole'), ['layer', q('F.Cu')], ['at', h.at.x, h.at.y],
      ['property', q('Reference'), q('H'), ['at', 0, 0], ['layer', q('F.SilkS')], ['hide', 'yes'], effects({ size: 1, width: 0.15 })],
      ['property', q('Value'), q('Hole'), ['at', 0, 0], ['layer', q('F.Fab')], ['hide', 'yes'], effects({ size: 1, width: 0.15 })],
      ['attr', 'exclude_from_pos_files', 'exclude_from_bom'],
      ['pad', q(''), 'np_thru_hole', 'circle', ['at', 0, 0], ['size', h.d, h.d], ['drill', h.d], ['layers', q('*.Cu'), q('*.Mask')]]]);
  }
  r.ok('hole', b.holes.length);
  for (const z of b.zones) {
    if (z.outline.length < 3) continue;
    const layer = z.keepout ? z.layer : cu(z.layer);
    const ze: W = ['zone', ['net', z.net && netIndex.has(z.net) ? netIndex.get(z.net)! : 0], ['net_name', q(z.net ?? '')], ['layer', q(layer)], ['hatch', 'edge', 0.5]];
    if (z.priority) ze.push(['priority', z.priority]);
    ze.push(['connect_pads', ['clearance', z.clearance ?? 0.3]], ['min_thickness', z.minWidth || 0.25]);
    if (z.keepout) ze.push(['keepout', ['tracks', 'not_allowed'], ['vias', 'not_allowed'], ['pads', 'allowed'], ['copperpour', 'not_allowed'], ['footprints', 'allowed']]);
    else ze.push(['fill', 'yes', ['thermal_gap', 0.5], ['thermal_bridge_width', 0.5]]);
    ze.push(['polygon', ['pts', ...z.outline.map(p => pt('xy', p))]]);
    e.push(ze);
  }
  r.ok('zone', b.zones.length);
  r.info('Zones are written unfilled — press B (Edit ▸ Fill All Zones) in KiCad after opening.');
  return writeSExpr(e) + '\n';
}
