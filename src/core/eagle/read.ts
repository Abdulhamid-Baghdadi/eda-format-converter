import { parseXml, child, children, path, type XNode } from '../xml';
import type { Board, Footprint, Graphic, Pad, Pin, PinType, Pt, Symbol, SymbolUnit, Text, Library, PlacedFootprint } from '../model';
import { rotUp, add, sub, normAngle, mirrorFootprintX, rotDown, dist, uniqueName } from '../geom';
import { Report } from '../report';
import { eagleLayerToKicad } from './layers';

const f = (s: string | undefined, d = 0) => { const v = parseFloat(s ?? ''); return Number.isFinite(v) ? v : d; };

export interface EagleRot { angle: number; mirror: boolean; spin: boolean }
export function parseRot(s?: string): EagleRot { const m = /^(S?)(M?)R?([-\d.]*)$/.exec(s ?? 'R0') ?? ['', '', '', '0']; return { spin: !!m[1], mirror: !!m[2], angle: f(m[3]) }; }

/** Arc for an Eagle wire with a `curve` (degrees, CCW positive, Y-up). Returns points in Y-up. */
export function curveArc(p1: Pt, p2: Pt, curve: number): { start: Pt; mid: Pt; end: Pt } {
  const d = dist(p1, p2);
  const half = (curve * Math.PI) / 360;
  const m = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
  const dir = { x: (p2.x - p1.x) / d, y: (p2.y - p1.y) / d };
  const n = { x: -dir.y, y: dir.x }; // left normal
  const h = d / 2 / Math.tan(half);
  const c = add(m, { x: n.x * h, y: n.y * h });
  return { start: p1, mid: add(c, rotUp(sub(p1, c), curve / 2)), end: p2 };
}

interface Ctx { r: Report; layer: (n: string) => string | null; design: DesignRules }
interface DesignRules { padRv: number; padMin: number; padMax: number; viaRv: number; viaMin: number; viaMax: number; smdRoundMin: number }

const unitVal = (s: string | undefined, d: number) => {
  if (!s) return d;
  const m = /^([-\d.]+)\s*(mm|mil|in|mic)?$/.exec(s.trim());
  if (!m) return d;
  const v = +m[1];
  return m[2] === 'mil' ? v * 0.0254 : m[2] === 'in' ? v * 25.4 : m[2] === 'mic' ? v / 1000 : v;
};
function readDesignRules(root: XNode): DesignRules {
  const p = new Map<string, string>();
  for (const x of children(path(root, 'drawing/board/designrules'), 'param')) p.set(x.attrs.name, x.attrs.value);
  const first = (k: string) => p.get(k)?.split(' ')[0];
  return {
    padRv: f(first('rvPadTop'), 0.25), padMin: unitVal(first('rlMinPadTop'), 0.254), padMax: unitVal(first('rlMaxPadTop'), 0.508),
    viaRv: f(first('rvViaOuter'), 0.25), viaMin: unitVal(first('rlMinViaOuter'), 0.2032), viaMax: unitVal(first('rlMaxViaOuter'), 0.508),
    smdRoundMin: 0,
  };
}
const DEFAULT_RULES: DesignRules = { padRv: 0.25, padMin: 0.254, padMax: 0.508, viaRv: 0.25, viaMin: 0.2032, viaMax: 0.508, smdRoundMin: 0 };
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

const yDown = (p: Pt): Pt => ({ x: p.x, y: -p.y });

/** Graphic primitives shared by packages, symbols and the board `plain` section. Output is Y-up unless `down`. */
function readPrims(n: XNode, ctx: Ctx, down: boolean, out: Graphic[], extraLayer?: (layerNo: string, g: Graphic) => boolean) {
  const P = (x: string, y: string) => { const p = { x: f(x), y: f(y) }; return down ? yDown(p) : p; };
  for (const c of n.children) {
    const a = c.attrs;
    if (!['wire', 'circle', 'rectangle', 'polygon', 'text'].includes(c.tag)) continue;
    const layer = ctx.layer(a.layer);
    if (!layer) { ctx.r.skip(`layer ${a.layer} item`, `Eagle layer ${a.layer} has no equivalent`); continue; }
    let g: Graphic | null = null;
    if (c.tag === 'wire') {
      const p1 = { x: f(a.x1), y: f(a.y1) }, p2 = { x: f(a.x2), y: f(a.y2) };
      const curve = f(a.curve);
      if (curve) {
        const arc = curveArc(p1, p2, curve);
        g = { type: 'arc', start: down ? yDown(arc.start) : arc.start, mid: down ? yDown(arc.mid) : arc.mid, end: down ? yDown(arc.end) : arc.end, width: f(a.width), layer };
      } else g = { type: 'line', a: P(a.x1, a.y1), b: P(a.x2, a.y2), width: f(a.width), layer };
    } else if (c.tag === 'circle') {
      const w = f(a.width);
      g = { type: 'circle', center: P(a.x, a.y), radius: f(a.radius), width: w, layer, fill: w === 0 };
    } else if (c.tag === 'rectangle') {
      const rot = parseRot(a.rot);
      const x1 = f(a.x1), y1 = f(a.y1), x2 = f(a.x2), y2 = f(a.y2);
      const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
      const corners = [{ x: x1, y: y1 }, { x: x2, y: y1 }, { x: x2, y: y2 }, { x: x1, y: y2 }].map(p => add({ x: cx, y: cy }, rotUp(sub(p, { x: cx, y: cy }), rot.angle)));
      g = { type: 'poly', pts: corners.map(p => (down ? yDown(p) : p)), width: 0, layer, fill: true, closed: true };
    } else if (c.tag === 'polygon') {
      const vs = children(c, 'vertex');
      const pts: Pt[] = [];
      vs.forEach((v, i) => {
        const p = { x: f(v.attrs.x), y: f(v.attrs.y) };
        pts.push(p);
        const cv = f(v.attrs.curve);
        if (cv) {
          const nx = vs[(i + 1) % vs.length];
          const arc = curveArc(p, { x: f(nx.attrs.x), y: f(nx.attrs.y) }, cv);
          pts.push(arc.mid);
          ctx.r.approx('polygon arc', 'curved polygon edges are approximated');
        }
      });
      g = { type: 'poly', pts: pts.map(p => (down ? yDown(p) : p)), width: f(a.width), layer, fill: true, closed: true };
    } else if (c.tag === 'text') {
      g = eagleText(c, ctx, down, layer);
    }
    if (g && !(extraLayer && extraLayer(a.layer, g))) { out.push(g); ctx.r.ok(g.type === 'text' ? 'text' : 'graphic'); }
  }
}

function eagleText(c: XNode, ctx: Ctx, down: boolean, layer: string): Text {
  const a = c.attrs;
  const rot = parseRot(a.rot);
  const size = f(a.size, 1.27);
  const ratio = f(a.ratio, 8) / 100;
  // Eagle anchors text at its bottom-left corner; we keep left justification and move to the vertical centre.
  const align = a.align ?? 'bottom-left';
  const [v, h] = align.includes('-') ? align.split('-') : align === 'center' ? ['center', 'center'] : ['bottom', 'left'];
  const shiftUp = v === 'bottom' ? size / 2 : v === 'top' ? -size / 2 : 0;
  const local = rotUp({ x: 0, y: shiftUp }, rot.angle);
  let p = add({ x: f(a.x), y: f(a.y) }, local);
  if (down) p = yDown(p);
  let justify: Text['justify'] = h === 'right' ? 'right' : h === 'center' ? 'center' : 'left';
  if (rot.mirror) justify = justify === 'left' ? 'right' : justify === 'right' ? 'left' : 'center';
  if (v !== 'center' || h !== 'center') ctx.r.approx('text anchor', 'Eagle text anchors are mapped to the closest KiCad justification');
  const text = c.text;
  return {
    type: 'text', at: p, text, size, width: size * ratio, layer, rotation: normAngle(rot.angle), mirror: rot.mirror, justify,
    role: /^>NAME$/i.test(text) ? 'reference' : /^>VALUE$/i.test(text) ? 'value' : 'user',
  };
}

function autoDia(drill: number, rv: number, min: number, max: number) { return drill + 2 * clamp(drill * rv, min, max); }

/** Package -> footprint (Y-down, top side). */
export function readPackage(pkg: XNode, ctx: Ctx): { fp: Footprint; nameText?: Text; valueText?: Text } {
  const fp: Footprint = { name: pkg.attrs.name, pads: [], graphics: [] };
  const desc = child(pkg, 'description');
  if (desc?.text) fp.description = stripHtml(desc.text);
  let nameText: Text | undefined, valueText: Text | undefined;
  readPrims(pkg, ctx, true, fp.graphics, (_l, g) => {
    if (g.type === 'text' && g.role === 'reference') { nameText = g; return true; }
    if (g.type === 'text' && g.role === 'value') { valueText = g; return true; }
    return false;
  });
  for (const c of pkg.children) {
    const a = c.attrs;
    if (c.tag === 'smd') {
      const rot = parseRot(a.rot);
      const roundness = f(a.roundness);
      const bottom = a.layer === '16';
      const pad: Pad = {
        number: a.name, kind: 'smd', shape: roundness >= 100 && f(a.dx) === f(a.dy) ? 'circle' : roundness >= 100 ? 'oval' : roundness > 0 ? 'roundrect' : 'rect',
        at: yDown({ x: f(a.x), y: f(a.y) }), rotation: normAngle(rot.angle), w: f(a.dx), h: f(a.dy), side: bottom ? 'B' : 'F',
        noPaste: a.cream === 'no', noMask: a.stop === 'no',
      };
      if (pad.shape === 'roundrect') pad.roundRatio = roundness / 200;
      fp.pads.push(pad); ctx.r.ok('pad');
    } else if (c.tag === 'pad') {
      const rot = parseRot(a.rot);
      const drill = f(a.drill);
      let d = f(a.diameter);
      if (!d) { d = autoDia(drill, ctx.design.padRv, ctx.design.padMin, ctx.design.padMax); ctx.r.approx('pad diameter', 'auto pad diameters computed from the design rules'); }
      const shape = a.shape ?? 'round';
      const pad: Pad = { number: a.name, kind: 'thru', shape: 'circle', at: yDown({ x: f(a.x), y: f(a.y) }), rotation: normAngle(rot.angle), w: d, h: d, drill: { w: drill, h: drill }, side: 'F' };
      if (shape === 'square') pad.shape = 'rect';
      else if (shape === 'octagon') pad.shape = 'octagon';
      else if (shape === 'long') { pad.shape = 'oval'; pad.w = 2 * d; }
      else if (shape === 'offset') { pad.shape = 'oval'; pad.w = 2 * d; pad.at = add(pad.at, rotDown({ x: d / 2, y: 0 }, pad.rotation)); ctx.r.approx('offset pad', 'offset (D-shaped) pads become ovals centred on the copper; the drill stays at the original position'); }
      if (a.first === 'yes' && shape === 'round') { /* first-pad marker shape is a display setting */ }
      fp.pads.push(pad); ctx.r.ok('pad');
    } else if (c.tag === 'hole') {
      const d = f(a.drill);
      fp.pads.push({ number: '', kind: 'npth', shape: 'circle', at: yDown({ x: f(a.x), y: f(a.y) }), rotation: 0, w: d, h: d, drill: { w: d, h: d }, side: 'F' });
      ctx.r.ok('hole');
    }
  }
  return { fp, nameText, valueText };
}

const stripHtml = (s: string) => s.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();

const PIN_DIR: Record<string, PinType> = { nc: 'no_connect', in: 'input', out: 'output', io: 'bidirectional', oc: 'open_collector', hiz: 'tri_state', pas: 'passive', pwr: 'power_in', sup: 'power_out' };
const PIN_LEN: Record<string, number> = { point: 0, short: 2.54, middle: 5.08, long: 7.62 };

function readSymbolGeom(sym: XNode, ctx: Ctx): { graphics: Graphic[]; pins: XNode[] } {
  const graphics: Graphic[] = [];
  readPrims(sym, ctx, false, graphics, (_l, g) => g.type === 'text' && g.role !== 'user');
  for (const g of graphics) if (g.type !== 'text' && g.layer === 'symbol') g.fill = g.fill ?? false;
  return { graphics, pins: children(sym, 'pin') };
}

function makePin(p: XNode, number: string, hidden: boolean): Pin {
  const a = p.attrs;
  const rot = parseRot(a.rot);
  const fn = a.function ?? 'none';
  return {
    name: a.name.replace(/@\d+$/, ''), number, at: { x: f(a.x), y: f(a.y) }, length: PIN_LEN[a.length ?? 'long'] ?? 7.62, angle: normAngle(rot.angle),
    type: PIN_DIR[a.direction ?? 'io'] ?? 'bidirectional', hidden: hidden || a.visible === 'off',
    shape: fn === 'dot' ? 'inverted' : fn === 'clk' ? 'clock' : fn === 'dotclk' ? 'inverted_clock' : 'line',
  };
}

/** Symbol-side layers become a pseudo layer; KiCad symbols do not have layers. */
const symLayer = (n: string) => (['94', '95', '96', '97', '98', '99'].includes(n) || +n >= 90 ? 'symbol' : eagleLayerToKicad(n));

export function readEagleLibrary(libNode: XNode, ctx: Ctx, libName: string): Library {
  const lib: Library = { symbols: [], footprints: [] };
  const pkgs = new Map<string, Footprint>();
  for (const p of children(child(libNode, 'packages'), 'package')) {
    const { fp, nameText, valueText } = readPackage(p, { ...ctx, layer: eagleLayerToKicad });
    if (nameText) fp.graphics.push({ ...nameText, text: '${REFERENCE}' });
    if (valueText) fp.graphics.push({ ...valueText, text: '${VALUE}' });
    pkgs.set(p.attrs.name, fp);
    lib.footprints.push(fp);
    ctx.r.ok('footprint');
  }
  const syms = new Map<string, XNode>();
  for (const s of children(child(libNode, 'symbols'), 'symbol')) syms.set(s.attrs.name, s);
  const symCtx = { ...ctx, layer: symLayer };
  const used = new Set<string>();
  for (const ds of children(child(libNode, 'devicesets'), 'deviceset')) {
    const gates = children(child(ds, 'gates'), 'gate');
    const devices = children(child(ds, 'devices'), 'device');
    for (const dev of devices.length ? devices : [{ tag: 'device', attrs: { name: '' }, children: [], text: '' } as XNode]) {
      const connects = new Map<string, string[]>();
      for (const c of children(child(dev, 'connects'), 'connect')) connects.set(`${c.attrs.gate}\u0000${c.attrs.pin}`, c.attrs.pad.split(/\s+/).filter(Boolean));
      const units: SymbolUnit[] = [];
      for (const g of gates) {
        const sym = syms.get(g.attrs.symbol);
        if (!sym) { ctx.r.skip('gate', `symbol ${g.attrs.symbol} missing`); continue; }
        const geom = readSymbolGeom(sym, symCtx);
        const pins: Pin[] = [];
        for (const p of geom.pins) {
          const pads = connects.get(`${g.attrs.name}\u0000${p.attrs.name}`);
          if (!dev.attrs.package || !pads) { pins.push(makePin(p, dev.attrs.package ? '' : p.attrs.name.replace(/@\d+$/, ''), false)); continue; }
          pads.forEach((pad, i) => pins.push(makePin(p, pad, i > 0)));
          if (pads.length > 1) ctx.r.approx('multi-pad pin', 'one Eagle pin on several pads becomes stacked KiCad pins (extra ones hidden)');
        }
        units.push({ name: g.attrs.name, graphics: geom.graphics, pins });
      }
      const base = ds.attrs.name.replace(/\*/g, '') + (dev.attrs.name ?? '').replace(/\*/g, '');
      const name = uniqueName(base || ds.attrs.name, used);
      const desc = child(ds, 'description')?.text;
      const props: Record<string, string> = {};
      const tech = child(child(dev, 'technologies'), 'technology');
      for (const at of children(tech, 'attribute')) if (at.attrs.value) props[at.attrs.name] = at.attrs.value;
      const s: Symbol = {
        name, reference: (ds.attrs.prefix ?? 'U'), value: name,
        footprint: dev.attrs.package ? `${libName}:${dev.attrs.package}` : undefined,
        description: desc ? stripHtml(desc) : undefined, properties: props, units,
        power: !dev.attrs.package && gates.length === 1 && units[0]?.pins.length === 1 && /^(sup|pwr)$/.test(syms.get(gates[0].attrs.symbol)?.children.find(c => c.tag === 'pin')?.attrs.direction ?? ''),
      };
      if (s.power) s.reference = '#PWR';
      lib.symbols.push(s);
      ctx.r.ok('symbol');
    }
  }
  return lib;
}

export function readEagleLbr(src: string, r = new Report(), name = 'eagle'): Library {
  const root = parseXml(src);
  const libNode = path(root, 'drawing/library');
  if (!libNode) throw new Error('Not an Eagle library (.lbr)');
  return readEagleLibrary(libNode, { r, layer: eagleLayerToKicad, design: DEFAULT_RULES }, name);
}

/** Eagle's `MRθ` rotates first and then mirrors about the Y axis (same as KiCad's own importer), which equals
 *  mirroring first and rotating by -θ — the form our model uses for bottom-side parts. */
export function readEagleBoard(src: string, r = new Report(), name = 'board'): Board {
  const root = parseXml(src);
  const brd = path(root, 'drawing/board');
  if (!brd) throw new Error('Not an Eagle board (.brd)');
  // copper layer compaction: inner layers in use get In1, In2 ...
  const usedInner = new Set<number>();
  const scan = (n: XNode) => { const l = +n.attrs.layer; if (l >= 2 && l <= 15) usedInner.add(l); n.children.forEach(scan); };
  scan(brd);
  const inner = [...usedInner].sort((a, b) => a - b);
  const layer = (n: string) => { const l = +n; if (l >= 2 && l <= 15) return `In${inner.indexOf(l) + 1}.Cu`; return eagleLayerToKicad(n); };
  const ctx: Ctx = { r, layer, design: readDesignRules(root) };
  const b: Board = { name, copperLayers: 2 + inner.length, footprints: [], tracks: [], vias: [], zones: [], graphics: [], holes: [], nets: [] };

  const plain = child(brd, 'plain');
  if (plain) {
    readPrims(plain, ctx, true, b.graphics, (l, g) => {
      if (['41', '42', '43'].includes(l) && g.type === 'poly') { b.zones.push({ layer: l === '42' ? 'B.Cu' : 'F.Cu', outline: g.pts, keepout: true }); r.ok('keepout area'); return true; }
      return false;
    });
    for (const h of children(plain, 'hole')) { b.holes.push({ at: yDown({ x: f(h.attrs.x), y: f(h.attrs.y) }), d: f(h.attrs.drill) }); r.ok('hole'); }
    if (children(plain, 'dimension').length) r.skip('dimension', 'dimensions are not converted', children(plain, 'dimension').length);
  }

  const packages = new Map<string, XNode>();
  for (const lib of children(child(brd, 'libraries'), 'library')) {
    for (const p of children(child(lib, 'packages'), 'package')) {
      packages.set(`${lib.attrs.name}\u0000${lib.attrs.urn ?? ''}\u0000${p.attrs.name}`, p);
      packages.set(`${lib.attrs.name}\u0000\u0000${p.attrs.name}`, p);
    }
  }
  const pkgCache = new Map<XNode, ReturnType<typeof readPackage>>();
  const elements = new Map<string, PlacedFootprint>();
  for (const e of children(child(brd, 'elements'), 'element')) {
    const a = e.attrs;
    const pkg = packages.get(`${a.library}\u0000${a.library_urn ?? ''}\u0000${a.package}`) ?? packages.get(`${a.library}\u0000\u0000${a.package}`);
    if (!pkg) { r.skip('element', `package ${a.package} not found`); continue; }
    let read = pkgCache.get(pkg);
    if (!read) { read = readPackage(pkg, { ...ctx, layer: eagleLayerToKicad }); pkgCache.set(pkg, read); }
    const rot = parseRot(a.rot);
    let fp: Footprint = structuredClone(read.fp);
    const texts: Text[] = [];
    if (read.nameText) texts.push({ ...read.nameText, text: a.name, role: 'reference' });
    if (read.valueText) texts.push({ ...read.valueText, text: a.value ?? '', role: 'value' });
    if (rot.mirror) {
      fp = mirrorFootprintX(fp);
      for (let i = 0; i < texts.length; i++) texts[i] = (mirrorFootprintX({ name: '', pads: [], graphics: [texts[i]] }).graphics[0] as Text);
    }
    const at = yDown({ x: f(a.x), y: f(a.y) });
    const pf: PlacedFootprint = { ref: a.name, value: a.value ?? '', at, rotation: normAngle(rot.mirror ? -rot.angle : rot.angle), side: rot.mirror ? 'bottom' : 'top', footprint: fp, texts, locked: a.locked === 'yes' };
    // smashed attributes carry absolute label positions
    for (const at2 of children(e, 'attribute')) {
      const role = at2.attrs.name === 'NAME' ? 'reference' : at2.attrs.name === 'VALUE' ? 'value' : null;
      if (!role || at2.attrs.x === undefined) continue;
      const lyr = eagleLayerToKicad(at2.attrs.layer ?? '25');
      if (!lyr) continue;
      const t = eagleText({ ...at2, text: '' }, ctx, true, lyr);
      const local = rotDown(sub(t.at, at), -pf.rotation);
      const old = texts.findIndex(x => x.role === role);
      const nt: Text = { ...t, at: local, rotation: normAngle(t.rotation - pf.rotation), text: role === 'reference' ? a.name : a.value ?? '', role, hidden: at2.attrs.display === 'off' };
      if (old >= 0) texts[old] = nt; else texts.push(nt);
    }
    b.footprints.push(pf);
    elements.set(a.name, pf);
    r.ok('footprint');
  }

  for (const s of children(child(brd, 'signals'), 'signal')) {
    const net = s.attrs.name;
    b.nets.push(net);
    for (const cr of children(s, 'contactref')) {
      const el = elements.get(cr.attrs.element);
      el?.footprint.pads.filter(p => p.number === cr.attrs.pad).forEach(p => (p.net = net));
    }
    for (const w of children(s, 'wire')) {
      const a = w.attrs;
      if (a.layer === '19') { r.skip('airwire', 'unrouted airwires are recreated by KiCad from the netlist'); continue; }
      const l = layer(a.layer);
      if (!l || !l.endsWith('.Cu')) { r.skip('signal wire', `wire on layer ${a.layer}`); continue; }
      const p1 = { x: f(a.x1), y: f(a.y1) }, p2 = { x: f(a.x2), y: f(a.y2) };
      const curve = f(a.curve);
      if (curve) { const arc = curveArc(p1, p2, curve); b.tracks.push({ layer: l, width: f(a.width), a: yDown(arc.start), mid: yDown(arc.mid), b: yDown(arc.end), net }); r.ok('track arc'); }
      else { b.tracks.push({ layer: l, width: f(a.width), a: yDown(p1), b: yDown(p2), net }); r.ok('track'); }
    }
    for (const v of children(s, 'via')) {
      const a = v.attrs;
      const drill = f(a.drill);
      let d = f(a.diameter);
      if (!d) d = autoDia(drill, ctx.design.viaRv, ctx.design.viaMin, ctx.design.viaMax);
      const [x, y] = (a.extent ?? '1-16').split('-');
      b.vias.push({ at: yDown({ x: f(a.x), y: f(a.y) }), size: d, drill, net, from: layer(x) ?? 'F.Cu', to: layer(y) ?? 'B.Cu' });
      if (a.shape && a.shape !== 'round') r.approx('via shape', 'square/octagon vias become round');
      r.ok('via');
    }
    for (const p of children(s, 'polygon')) {
      const l = layer(p.attrs.layer);
      if (!l) continue;
      const g: Graphic[] = [];
      readPrims({ ...s, children: [p] }, ctx, true, g);
      const poly = g[0];
      if (poly?.type === 'poly') {
        b.zones.push({ layer: l, net, outline: poly.pts, clearance: f(p.attrs.isolate) || undefined, minWidth: f(p.attrs.width) || undefined, priority: p.attrs.rank ? Math.max(0, 7 - f(p.attrs.rank)) : undefined });
        r.ok('zone');
      }
    }
  }
  return b;
}
