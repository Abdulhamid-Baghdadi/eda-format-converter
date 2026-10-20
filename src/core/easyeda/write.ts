import type { Board, Footprint, Graphic, Pad, Pin, Pt, Symbol, SymbolUnit, Text } from '../model';
import { arcSweep, rotDown, add, normAngle, round, footprintBBox, uniqueName } from '../geom';
import { Report } from '../report';
import { U } from './read';

const EDITOR = '6.5.40';
const LAYERS = [
  '1~TopLayer~#FF0000~true~true~true~', '2~BottomLayer~#0000FF~true~false~true~', '3~TopSilkLayer~#FFCC00~true~false~true~',
  '4~BottomSilkLayer~#66CC33~true~false~true~', '5~TopPasteMaskLayer~#808080~true~false~true~', '6~BottomPasteMaskLayer~#800000~true~false~true~',
  '7~TopSolderMaskLayer~#800080~true~false~true~0.3', '8~BottomSolderMaskLayer~#AA00FF~true~false~true~0.3', '9~Ratlines~#6464FF~true~false~true~',
  '10~BoardOutLine~#FF00FF~true~false~true~', '11~Multi-Layer~#C0C0C0~true~false~true~', '12~Document~#FFFFFF~true~false~true~',
  '13~TopAssembly~#33CC99~false~false~false~', '14~BottomAssembly~#5555FF~false~false~false~', '15~Mechanical~#F022F0~false~false~false~',
  '19~3DModel~#66CCFF~false~false~false~', ...Array.from({ length: 32 }, (_, i) => `${i + 21}~Inner${i + 1}~#999966~false~false~false~~`),
  '99~ComponentShapeLayer~#00CCCC~false~false~false~0.4', '100~LeadShapeLayer~#CC9999~false~false~false~', '101~ComponentMarkingLayer~#66FFCC~false~false~false~',
];
const LAYER_IDS: Record<string, string> = {
  'F.Cu': '1', 'B.Cu': '2', 'F.SilkS': '3', 'B.SilkS': '4', 'F.Paste': '5', 'B.Paste': '6', 'F.Mask': '7', 'B.Mask': '8', 'Edge.Cuts': '10',
  'Dwgs.User': '12', 'Cmts.User': '12', 'F.Fab': '13', 'B.Fab': '14', 'F.CrtYd': '15', 'B.CrtYd': '15', 'Margin': '15', 'Eco1.User': '12', 'Eco2.User': '12',
};
export const eeLayerId = (l: string) => { const m = /^In(\d+)\.Cu$/.exec(l); return m ? String(20 + +m[1]) : LAYER_IDS[l] ?? '12'; };

const r4 = (v: number) => round(v, 4);

export class Ids { private i = 0; next() { return 'gge' + (++this.i); } }

/** Converts mm (Y-down) to EasyEDA canvas units around an origin. */
interface Xf { ox: number; oy: number; ids: Ids; r: Report }
const X = (c: Xf, p: Pt) => `${r4(c.ox + p.x / U)} ${r4(c.oy + p.y / U)}`;
const xs = (c: Xf, p: Pt) => [r4(c.ox + p.x / U), r4(c.oy + p.y / U)];

function arcPath(c: Xf, s: Pt, m: Pt, e: Pt): string {
  const a = arcSweep(s, m, e);
  if (!a) return `M ${X(c, s)} L ${X(c, e)}`;
  const r = r4(a.radius / U);
  return `M ${X(c, s)} A ${r} ${r} 0 ${Math.abs(a.sweep) > 180 ? 1 : 0} ${a.sweep > 0 ? 1 : 0} ${X(c, e)}`;
}

function graphicShapes(g: Graphic, c: Xf, net = ''): string[] {
  const L = eeLayerId(g.layer);
  const w = r4(g.width / U);
  switch (g.type) {
    case 'line': return [`TRACK~${w}~${L}~${net}~${X(c, g.a)} ${X(c, g.b)}~${c.ids.next()}~0`];
    case 'arc': return [`ARC~${w}~${L}~${net}~${arcPath(c, g.start, g.mid, g.end)}~~${c.ids.next()}~0`];
    case 'circle':
      if (g.fill) return [`SOLIDREGION~${L}~${net}~${circlePath(c, g.center, g.radius)}~solid~${c.ids.next()}~~~~0`];
      return [`CIRCLE~${X(c, g.center).replace(' ', '~')}~${r4(g.radius / U)}~${w}~${L}~${c.ids.next()}~0~~`];
    case 'rect': {
      const pts = [g.a, { x: g.b.x, y: g.a.y }, g.b, { x: g.a.x, y: g.b.y }];
      if (g.fill) return [`SOLIDREGION~${L}~${net}~M ${pts.map(p => X(c, p)).join(' L ')} Z~solid~${c.ids.next()}~~~~0`];
      return [`TRACK~${w}~${L}~${net}~${[...pts, pts[0]].map(p => X(c, p)).join(' ')}~${c.ids.next()}~0`];
    }
    case 'poly':
      if (g.fill && g.closed) return [`SOLIDREGION~${L}~${net}~M ${g.pts.map(p => X(c, p)).join(' L ')} Z~solid~${c.ids.next()}~~~~0`];
      return [`TRACK~${w || r4(0.1 / U)}~${L}~${net}~${(g.closed ? [...g.pts, g.pts[0]] : g.pts).map(p => X(c, p)).join(' ')}~${c.ids.next()}~0`];
    case 'text': return [textShape(g, c, g.role === 'reference' ? 'P' : g.role === 'value' ? 'N' : 'L')];
  }
}
const circlePath = (c: Xf, ctr: Pt, r: number) => {
  const a = { x: ctr.x - r, y: ctr.y }, b = { x: ctr.x + r, y: ctr.y }, rr = r4(r / U);
  return `M ${X(c, a)} A ${rr} ${rr} 0 0 1 ${X(c, b)} A ${rr} ${rr} 0 0 1 ${X(c, a)} Z`;
};

/** Rough advance width of KiCad's stroke font, used to move centred text to EasyEDA's baseline-start anchor. */
const textWidth = (t: Text) => t.text.length * t.size * 0.75;
function textShape(t: Text, c: Xf, kind: string): string {
  const shift = t.justify === 'left' ? 0 : t.justify === 'right' ? textWidth(t) : textWidth(t) / 2;
  const along = rotDown({ x: t.mirror ? shift : -shift, y: t.size / 2 }, t.rotation);
  if (shift) c.r.approx('text anchor', 'centred text is re-anchored at its baseline start using an estimated text width');
  const [x, y] = xs(c, add(t.at, along));
  return `TEXT~${kind}~${x}~${y}~${r4((t.width || t.size * 0.15) / U)}~${normAngle(t.rotation)}~${t.mirror ? 1 : 0}~${eeLayerId(t.layer)}~~${r4(t.size / U / 0.85)}~${t.text}~~${t.hidden ? 'none' : ''}~${c.ids.next()}`;
}

function padShape(p: Pad, c: Xf, fpAt: Pt, fpRot: number, warnRound: Report): string {
  const at = add(fpAt, rotDown(p.at, fpRot));
  const rot = normAngle(p.rotation + fpRot);
  const [x, y] = xs(c, at);
  const layer = p.kind === 'smd' ? (p.side === 'B' ? '2' : '1') : '11';
  let shape = 'RECT';
  let pts: Pt[] = [];
  const corner = (dx: number, dy: number) => add(at, rotDown({ x: dx, y: dy }, rot));
  const hw = p.w / 2, hh = p.h / 2;
  if (p.shape === 'circle') shape = 'ELLIPSE';
  else if (p.shape === 'oval') { shape = Math.abs(p.w - p.h) < 1e-6 ? 'ELLIPSE' : 'OVAL'; pts = p.w > p.h ? [corner(-(hw - hh), 0), corner(hw - hh, 0)] : [corner(0, -(hh - hw)), corner(0, hh - hw)]; }
  else if (p.shape === 'custom' && p.poly?.length) { shape = 'POLYGON'; pts = p.poly.map(q => add(at, rotDown(q, rot))); }
  else if (p.shape === 'octagon') {
    shape = 'POLYGON'; const k = 0.4142;
    pts = [[-hw, -hh * k], [-hw * k, -hh], [hw * k, -hh], [hw, -hh * k], [hw, hh * k], [hw * k, hh], [-hw * k, hh], [-hw, hh * k]].map(([a, b]) => corner(a, b));
  } else {
    if (p.shape === 'roundrect' && (p.roundRatio ?? 0) > 0.05) warnRound.approx('rounded pad', 'EasyEDA Standard has no rounded-rectangle pads; they become rectangles');
    pts = [corner(-hw, -hh), corner(hw, -hh), corner(hw, hh), corner(-hw, hh)];
  }
  const holeR = p.drill ? Math.min(p.drill.w, p.drill.h) / 2 / U : 0;
  const slot = p.drill && p.drill.w !== p.drill.h ? Math.max(p.drill.w, p.drill.h) / U : 0;
  let holePts = '';
  if (slot && p.drill) {
    const along = p.drill.w > p.drill.h ? { x: (Math.max(p.drill.w, p.drill.h) - Math.min(p.drill.w, p.drill.h)) / 2, y: 0 } : { x: 0, y: (p.drill.h - p.drill.w) / 2 };
    holePts = `${X(c, add(at, rotDown({ x: -along.x, y: -along.y }, rot)))} ${X(c, add(at, rotDown(along, rot)))}`;
  }
  const w = p.shape === 'custom' ? p.w : p.w, h = p.h;
  return `PAD~${shape}~${x}~${y}~${r4(w / U)}~${r4(h / U)}~${layer}~${p.net ?? ''}~${p.number}~${r4(holeR)}~${pts.map(q => X(c, q)).join(' ')}~${rot}~${c.ids.next()}~${r4(slot)}~${holePts}~${p.kind === 'npth' ? 'N' : 'Y'}~0`;
}

function footprintShapes(fp: Footprint, c: Xf, at: Pt = { x: 0, y: 0 }, rot = 0, texts?: Text[], ref?: string, value?: string): string[] {
  const out: string[] = [];
  const W = (p: Pt) => add(at, rotDown(p, rot));
  for (const g of fp.graphics) {
    const t = mapG(g, W, rot);
    if (t.type === 'text' && /^\$\{(REFERENCE|VALUE)\}$/.test(t.text)) { out.push(textShape({ ...t, text: t.text === '${REFERENCE}' ? ref ?? 'U?' : value ?? fp.name }, c, t.text === '${REFERENCE}' ? 'P' : 'N')); continue; }
    out.push(...graphicShapes(t, c));
  }
  for (const t of texts ?? []) out.push(textShape(mapG(t, W, rot) as Text, c, t.role === 'reference' ? 'P' : t.role === 'value' ? 'N' : 'L'));
  for (const p of fp.pads) out.push(padShape(p, c, at, rot, c.r));
  for (const h of fp.holes ?? []) out.push(`HOLE~${X(c, W(h.at)).replace(' ', '~')}~${r4(h.d / 2 / U)}~${c.ids.next()}~0`);
  for (const m of fp.model3d ?? []) c.r.skip('3D model', `EasyEDA 3D models live on the EasyEDA server; ${m.path.split('/').pop()} is not linked`);
  return out;
}

function mapG(g: Graphic, f: (p: Pt) => Pt, rot: number): Graphic {
  switch (g.type) {
    case 'line': return { ...g, a: f(g.a), b: f(g.b) };
    case 'arc': return { ...g, start: f(g.start), mid: f(g.mid), end: f(g.end) };
    case 'circle': return { ...g, center: f(g.center) };
    case 'rect': return rot % 90 === 0 ? { ...g, a: f(g.a), b: f(g.b) } : { type: 'poly', pts: [g.a, { x: g.b.x, y: g.a.y }, g.b, { x: g.a.x, y: g.b.y }].map(f), width: g.width, layer: g.layer, fill: g.fill, closed: true };
    case 'poly': return { ...g, pts: g.pts.map(f) };
    case 'text': return { ...g, at: f(g.at), rotation: normAngle(g.rotation + rot) };
  }
}

function bbox(c: Xf, fp: { x0: number; y0: number; x1: number; y1: number }) {
  return { x: r4(c.ox + fp.x0 / U), y: r4(c.oy + fp.y0 / U), width: r4((fp.x1 - fp.x0) / U), height: r4((fp.y1 - fp.y0) / U) };
}

export function writeEasyFootprint(fp: Footprint, r = new Report()): string {
  const c: Xf = { ox: 4000, oy: 3000, ids: new Ids(), r };
  const shape = footprintShapes(fp, c, { x: 0, y: 0 }, 0, undefined, 'U?', fp.name);
  r.ok('footprint');
  const doc = {
    head: { docType: '4', editorVersion: EDITOR, newgId: true, c_para: { package: fp.name, pre: 'U?', Contributor: 'eda-format-converter' }, x: 4000, y: 3000, hasIdFlag: true, importFlag: 0, transformList: '' },
    canvas: 'CA~1000~1000~#000000~yes~#FFFFFF~10~1000~1000~line~0.5~mm~1~45~visible~0.5~4000~3000~0~yes',
    shape, layers: LAYERS, objects: [], BBox: bbox(c, footprintBBox(fp)), netColors: {},
  };
  return JSON.stringify(doc, null, 1);
}

// ---------------------------------------------------------------- symbols
const ELECTRIC: Record<string, string> = { input: '1', output: '2', bidirectional: '3', tri_state: '3', power_in: '4', power_out: '4' };

function pinShape(p: Pin, S: (q: Pt) => number[], ids: Ids): string {
  const [x, y] = S(p.at);
  const len = r4(p.length / U);
  const rot = normAngle(180 - p.angle);
  const dir = { 0: [1, 0], 90: [0, -1], 180: [-1, 0], 270: [0, 1] }[normAngle(Math.round(p.angle / 90) * 90) as 0 | 90 | 180 | 270] ?? [1, 0];
  const path = dir[0] ? `M ${x} ${y} h ${dir[0] * len}` : `M ${x} ${y} v ${dir[1] * len}`;
  const ex = x + dir[0] * len, ey = y + dir[1] * len;
  // name inside the body, number above the pin line
  const nx = ex + dir[0] * 3, ny = ey + dir[1] * 3 + (dir[0] ? 3 : 0);
  const mx = (x + ex) / 2, my = (y + ey) / 2 - (dir[0] ? 1 : 0);
  const show = p.hidden ? 'none' : 'show';
  const anchorName = dir[0] > 0 ? 'start' : dir[0] < 0 ? 'end' : 'middle';
  const dot = p.shape === 'inverted' || p.shape === 'inverted_clock' ? 1 : 0;
  const clk = p.shape === 'clock' || p.shape === 'inverted_clock' ? 1 : 0;
  return [
    `P~${show}~${ELECTRIC[p.type] ?? '0'}~${p.number}~${x}~${y}~${rot}~${ids.next()}~0`, `${x}~${y}`, `${path}~#880000`,
    `1~${r4(nx)}~${r4(ny)}~0~${p.name}~${anchorName}~~~#0000FF`, `1~${r4(mx)}~${r4(my)}~0~${p.number}~middle~~~#0000FF`,
    `${dot}~${r4(ex - dir[0] * 3)}~${r4(ey - dir[1] * 3)}`, `${clk}~M ${ex} ${ey}`,
  ].join('^^');
}

/** Body graphics and pins of one symbol unit as EasyEDA shapes; S maps model (Y-up mm) points to canvas units. */
export function unitShapes(u: SymbolUnit, S: (p: Pt) => number[], ids: Ids): string[] {
  const shape: string[] = [];
  for (const g of u.graphics) {
    const w = r4(Math.max(g.width, 0.1524) / U);
    const fill = g.fill ? '#FFFFFF' : 'none';
    switch (g.type) {
      case 'rect': { const [x1, y1] = S(g.a), [x2, y2] = S(g.b); shape.push(`R~${Math.min(x1, x2)}~${Math.min(y1, y2)}~~~${r4(Math.abs(x2 - x1))}~${r4(Math.abs(y2 - y1))}~#880000~${w}~0~${fill}~${ids.next()}~0~`); break; }
      case 'circle': { const [x, y] = S(g.center); const rr = r4(g.radius / U); shape.push(`E~${x}~${y}~${rr}~${rr}~#880000~${w}~0~${fill}~${ids.next()}~0`); break; }
      case 'line': shape.push(`PL~${S(g.a).join(' ')} ${S(g.b).join(' ')}~#880000~${w}~0~none~${ids.next()}~0`); break;
      case 'poly': shape.push(`${g.closed ? 'PG' : 'PL'}~${g.pts.map(p => S(p).join(' ')).join(' ')}~#880000~${w}~0~${g.closed ? fill : 'none'}~${ids.next()}~0`); break;
      case 'arc': {
        const a = arcSweep(g.start, g.mid, g.end);
        const [sx, sy] = S(g.start), [ex, ey] = S(g.end);
        if (!a) { shape.push(`PL~${sx} ${sy} ${ex} ${ey}~#880000~${w}~0~none~${ids.next()}~0`); break; }
        const rr = r4(a.radius / U);
        // Y flips, so a CCW (Y-up) sweep becomes clockwise on the EasyEDA canvas: sweep-flag 0
        shape.push(`A~M ${sx} ${sy} A ${rr} ${rr} 0 ${Math.abs(a.sweep) > 180 ? 1 : 0} ${a.sweep > 0 ? 0 : 1} ${ex} ${ey}~~#880000~${w}~0~none~${ids.next()}~0`);
        break;
      }
      case 'text': { const [x, y] = S(g.at); shape.push(`T~L~${x}~${y}~${normAngle(g.rotation)}~#0000FF~~${r4(g.size / 0.3528 / 0.8)}pt~~~~comment~${g.text}~1~${g.justify === 'left' ? 'start' : g.justify === 'right' ? 'end' : 'middle'}~${ids.next()}~0~`); break; }
    }
  }
  for (const p of u.pins) shape.push(pinShape(p, S, ids));
  return shape;
}

export function writeEasySymbol(s: Symbol, r = new Report()): string[] {
  // EasyEDA Standard symbols have one unit per document; multi-unit symbols become one document per unit.
  if (s.units.length > 1) r.approx('multi-unit symbol', 'each unit becomes its own EasyEDA symbol');
  return s.units.map((u, ui) => {
    const ox = 400, oy = 300, ids = new Ids();
    const S = (p: Pt) => [r4(ox + p.x / U), r4(oy - p.y / U)];
    const shape = unitShapes(u, S, ids);
    const ys = u.pins.map(p => S(p.at)[1]).concat(u.graphics.flatMap(g => g.type === 'rect' ? [S(g.a)[1], S(g.b)[1]] : []));
    const top = ys.length ? Math.min(...ys) : oy;
    shape.push(`T~P~${ox}~${r4(top - 8)}~0~#000080~Arial~~~~~comment~${s.reference}?~1~start~${ids.next()}~0~pinpart`);
    shape.push(`T~N~${ox}~${r4(top - 16)}~0~#000080~Arial~~~~~comment~${s.value ?? s.name}~1~start~${ids.next()}~0~pinpart`);
    r.ok('symbol');
    const name = s.units.length > 1 ? `${s.name}.${ui + 1}` : s.name;
    return JSON.stringify({
      head: { docType: '2', editorVersion: EDITOR, c_para: { pre: `${s.reference}?`, name, package: s.footprint?.replace(/^.*:/, '') ?? '', ...s.properties, ...(s.datasheet ? { link: s.datasheet } : {}) }, x: ox, y: oy, hasIdFlag: true, importFlag: 0 },
      canvas: `CA~1000~1000~#FFFFFF~yes~#CCCCCC~5~1000~1000~line~5~pixel~5~${ox}~${oy}`, shape, BBox: { x: ox - 100, y: oy - 100, width: 200, height: 200 }, colors: {},
    }, null, 1);
  });
}

// ---------------------------------------------------------------- boards
export function writeEasyBoard(b: Board, r = new Report()): string {
  const c: Xf = { ox: 4000, oy: 3000, ids: new Ids(), r };
  const shape: string[] = [];
  for (const g of b.graphics) shape.push(...graphicShapes(g, c));
  for (const t of b.tracks) {
    const L = eeLayerId(t.layer), w = r4(t.width / U);
    shape.push(t.mid ? `ARC~${w}~${L}~${t.net ?? ''}~${arcPath(c, t.a, t.mid, t.b)}~~${c.ids.next()}~0` : `TRACK~${w}~${L}~${t.net ?? ''}~${X(c, t.a)} ${X(c, t.b)}~${c.ids.next()}~0`);
  }
  r.ok('track', b.tracks.length);
  for (const v of b.vias) shape.push(`VIA~${X(c, v.at).replace(' ', '~')}~${r4(v.size / U)}~${v.net ?? ''}~${r4(v.drill / 2 / U)}~${c.ids.next()}~0`);
  r.ok('via', b.vias.length);
  if (b.vias.some(v => (v.from && v.from !== 'F.Cu') || (v.to && v.to !== 'B.Cu'))) r.approx('blind/buried via', 'EasyEDA Standard vias are always through');
  for (const h of b.holes) shape.push(`HOLE~${X(c, h.at).replace(' ', '~')}~${r4(h.d / 2 / U)}~${c.ids.next()}~0`);
  for (const z of b.zones) {
    if (z.outline.length < 3) continue;
    const path = 'M ' + z.outline.map(p => X(c, p)).join(' L ') + ' Z';
    if (z.keepout) { shape.push(`SOLIDREGION~${eeLayerId(z.layer)}~~${path}~cutout~${c.ids.next()}~~~~0`); r.approx('keepout', 'keepout areas become cutout regions'); continue; }
    shape.push(`COPPERAREA~${r4((z.minWidth ?? 0.25) / U)}~${eeLayerId(z.layer)}~${z.net ?? ''}~${path}~${r4((z.clearance ?? 0.3) / U)}~solid~${c.ids.next()}~spoke~none~~0~~2~1~1~0~yes`);
  }
  r.ok('zone', b.zones.length);
  const used = new Set<string>();
  for (const f of b.footprints) {
    const pkg = uniqueName(f.footprint.name, used);
    const sub = footprintShapes(f.footprint, c, f.at, f.rotation, f.texts, f.ref, f.value);
    if (!f.texts?.some(t => t.role === 'reference')) sub.unshift(textShape({ type: 'text', at: f.at, text: f.ref, size: 1, width: 0.15, rotation: 0, layer: f.side === 'bottom' ? 'B.SilkS' : 'F.SilkS', role: 'reference' }, c, 'P'));
    const [x, y] = xs(c, f.at);
    shape.push([`LIB~${x}~${y}~package\`${pkg}\`~${normAngle(f.rotation)}~~${c.ids.next()}~0~~0`, ...sub].join('#@$'));
    r.ok('footprint');
  }
  if (b.copperLayers > 2) r.info(`Board has ${b.copperLayers} copper layers — enable the inner layers in EasyEDA's Layer Manager after import.`);
  const all: Pt[] = b.graphics.filter(g => g.layer === 'Edge.Cuts').flatMap(g => g.type === 'line' ? [g.a, g.b] : g.type === 'arc' ? [g.start, g.end] : g.type === 'poly' ? g.pts : g.type === 'rect' ? [g.a, g.b] : []);
  const bb = all.length ? { x0: Math.min(...all.map(p => p.x)), y0: Math.min(...all.map(p => p.y)), x1: Math.max(...all.map(p => p.x)), y1: Math.max(...all.map(p => p.y)) } : { x0: 0, y0: 0, x1: 100, y1: 100 };
  return JSON.stringify({
    head: { docType: '3', editorVersion: EDITOR, newgId: true, c_para: {}, x: 4000, y: 3000, hasIdFlag: true, importFlag: 0, transformList: '' },
    canvas: 'CA~1000~1000~#000000~yes~#FFFFFF~10~1000~1000~line~0.5~mm~1~45~visible~0.5~4000~3000~0~yes',
    shape, layers: LAYERS.map((l, i) => (b.copperLayers > 2 && /^(2[1-9]|[3-5]\d)~/.test(l) && +l.split('~')[0] - 20 <= b.copperLayers - 2 ? l.replace(/~false~false~false~/, '~true~false~true~') : l) + (i < 0 ? '' : '')),
    objects: [], BBox: bbox(c, bb), preference: { hideFootprints: '', hideNets: '' },
    DRCRULE: { Default: { trackWidth: 1, clearance: 0.6, viaHoleDiameter: 2.4, viaHoleD: 1.2 }, isRealtime: false, isDrcOnRoutingOrPlaceVia: false, checkObjectToCopperarea: true, showDRCRangeLine: true },
    netColors: {},
  }, null, 1);
}
