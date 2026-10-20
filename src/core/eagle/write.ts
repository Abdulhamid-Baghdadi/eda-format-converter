import type { Board, Footprint, Graphic, Pin, Pt, Text, Library } from '../model';
import { arcSweep, normAngle, mirrorFootprintX, rotDown, add, uniqueName } from '../geom';
import { el, fmt } from '../xml';
import { Report } from '../report';
import { EAGLE_LAYERS, kicadLayerToEagle } from './layers';

const up = (p: Pt): Pt => ({ x: p.x, y: -p.y });
const nm = (s: string) => s.replace(/\s+/g, '_').replace(/[^\x21-\x7e]/g, '_') || 'X';

function header(): string {
  return '<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE eagle SYSTEM "eagle.dtd">\n<eagle version="9.6.2">\n<drawing>\n' +
    '<settings>\n<setting alwaysvectorfont="no"/>\n<setting verticaltext="up"/>\n</settings>\n' +
    '<grid distance="0.05" unitdist="inch" unit="inch" style="lines" multiple="1" display="no" altdistance="0.01" altunitdist="inch" altunit="inch"/>\n' +
    el('layers', {}, EAGLE_LAYERS.map(([n, name, color, fill]) => el('layer', { number: n, name, color, fill, visible: 'yes', active: 'yes' })));
}
const footer = '</drawing>\n</eagle>\n';

/** Graphics in Y-down mm -> Eagle primitives (Y-up). `layerOf` chooses the Eagle layer. */
function prims(gs: Graphic[], layerOf: (g: Graphic) => number, r: Report, yDown = true): string[] {
  const P = (p: Pt) => (yDown ? up(p) : p);
  const out: string[] = [];
  for (const g of gs) {
    const layer = layerOf(g);
    switch (g.type) {
      case 'line': { const a = P(g.a), b = P(g.b); out.push(el('wire', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, width: g.width, layer })); break; }
      case 'arc': {
        const s = P(g.start), m = P(g.mid), e = P(g.end);
        const a = arcSweep(s, m, e);
        out.push(el('wire', { x1: s.x, y1: s.y, x2: e.x, y2: e.y, width: g.width, layer, curve: a ? fmt(a.sweep) : undefined }));
        break;
      }
      case 'circle': { const c = P(g.center); out.push(el('circle', { x: c.x, y: c.y, radius: g.radius, width: g.fill ? 0 : g.width, layer })); break; }
      case 'rect': {
        const a = P(g.a), b = P(g.b);
        if (g.fill) out.push(el('rectangle', { x1: Math.min(a.x, b.x), y1: Math.min(a.y, b.y), x2: Math.max(a.x, b.x), y2: Math.max(a.y, b.y), layer }));
        else { const c = [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }]; c.forEach((p, i) => { const q = c[(i + 1) % 4]; out.push(el('wire', { x1: p.x, y1: p.y, x2: q.x, y2: q.y, width: g.width, layer })); }); }
        break;
      }
      case 'poly': {
        const pts = g.pts.map(P);
        if (g.fill && g.closed && pts.length >= 3) out.push(el('polygon', { width: g.width || 0.001, layer }, pts.map(p => el('vertex', { x: p.x, y: p.y }))));
        else {
          const seq = g.closed ? [...pts, pts[0]] : pts;
          for (let i = 1; i < seq.length; i++) out.push(el('wire', { x1: seq[i - 1].x, y1: seq[i - 1].y, x2: seq[i].x, y2: seq[i].y, width: g.width, layer }));
        }
        break;
      }
      case 'text': out.push(textEl(g, layer, yDown)); break;
    }
  }
  return out;
}

function textEl(t: Text, layer: number, yDown = true, content?: string): string {
  // our anchor is the vertical centre; Eagle's default is bottom-left, so use an explicit centre-left align.
  const p = yDown ? up(t.at) : t.at;
  const align = t.justify === 'right' ? 'center-right' : t.justify === 'left' ? 'center-left' : 'center';
  return el('text', { x: p.x, y: p.y, size: t.size, layer, rot: `${t.mirror ? 'M' : ''}R${fmt(normAngle(t.rotation))}`, ratio: t.width && t.size ? Math.round(Math.min(31, (t.width / t.size) * 100)) : undefined, align }, [], content ?? t.text);
}

/** Package from a top-side footprint. Returns the package XML and the pad-name mapping (pad number -> Eagle pad names). */
function packageXml(fp: Footprint, name: string, r: Report): { xml: string; padNames: Map<string, string[]> } {
  const parts: string[] = [];
  if (fp.description) parts.push(el('description', {}, [], fp.description));
  const used = new Set<string>();
  const padNames = new Map<string, string[]>();
  let mp = 0;
  const graphics = fp.graphics.filter(g => !(g.type === 'text' && /^\$\{(REFERENCE|VALUE)\}$/.test(g.text)));
  const labels = fp.graphics.filter((g): g is Text => g.type === 'text' && /^\$\{(REFERENCE|VALUE)\}$/.test(g.text));
  parts.push(...prims(graphics, g => kicadLayerToEagle(g.layer), r));
  for (const p of fp.pads) {
    const base = p.number ? nm(p.number) : `MP${++mp}`;
    const pn = uniqueName(base, used);
    if (pn !== base) r.approx('duplicate pad name', 'Eagle pad names must be unique: repeated numbers get a _2, _3 … suffix (all are connected to the same pin)');
    if (p.number) padNames.set(p.number, [...(padNames.get(p.number) ?? []), pn]);
    const at = up(p.at);
    const rot = `R${fmt(normAngle(p.rotation))}`;
    if (p.kind === 'smd') {
      let roundness = 0;
      if (p.shape === 'circle' || p.shape === 'oval') roundness = 100;
      else if (p.shape === 'roundrect') roundness = Math.round(Math.min(100, (p.roundRatio ?? 0.25) * 200));
      if (p.shape === 'custom') r.approx('custom pad', 'custom-shaped SMD pads become their bounding rectangle');
      parts.push(el('smd', { name: pn, x: at.x, y: at.y, dx: p.w, dy: p.h, layer: p.side === 'B' ? 16 : 1, roundness: roundness || undefined, rot: rot === 'R0' ? undefined : rot, stop: p.noMask ? 'no' : undefined, cream: p.noPaste ? 'no' : undefined }));
    } else if (p.kind === 'npth' && p.drill) {
      parts.push(el('hole', { x: at.x, y: at.y, drill: Math.min(p.drill.w, p.drill.h) }));
    } else {
      const drill = p.drill ? Math.min(p.drill.w, p.drill.h) : 0.8;
      if (p.drill && p.drill.w !== p.drill.h) r.approx('slotted hole', 'Eagle pads have round drills; slots become round holes (add the slot on the Milling layer)');
      let shape: string | undefined;
      let diameter = Math.min(p.w, p.h);
      const ratio = Math.max(p.w, p.h) / Math.min(p.w, p.h);
      if (p.shape === 'rect' || p.shape === 'roundrect') { shape = 'square'; if (ratio > 1.001) r.approx('rectangular THT pad', 'Eagle through-hole pads are square/round/octagon/long only: non-square rectangles become squares of the smaller side'); }
      else if (p.shape === 'octagon') shape = 'octagon';
      else if ((p.shape === 'oval' || p.shape === 'custom') && ratio > 1.001) {
        // Eagle "long" pads are always 2:1 (default elongation); use them only when that is close
        if (ratio >= 1.6) shape = 'long';
        r.approx('oval THT pad', 'Eagle through-hole pads are round or 2:1 "long" only: ovals become long pads (ratio ≥ 1.6) or round pads of the smaller side');
      }
      let prot = normAngle(p.rotation);
      if (shape === 'long' && p.h > p.w) prot = normAngle(prot + 90);
      if (shape === undefined && ratio <= 1.001) diameter = p.w;
      parts.push(el('pad', { name: pn, x: at.x, y: at.y, drill, diameter, shape, rot: prot ? `R${fmt(prot)}` : undefined }));
    }
  }
  for (const h of fp.holes ?? []) { const at = up(h.at); parts.push(el('hole', { x: at.x, y: at.y, drill: h.d })); }
  const bb = fp.pads.length ? Math.max(...fp.pads.map(p => -p.at.y + p.h)) : 1;
  const nameT = labels.find(t => t.text === '${REFERENCE}');
  const valT = labels.find(t => t.text === '${VALUE}');
  parts.push(nameT ? textEl(nameT, 25, true, '>NAME') : el('text', { x: 0, y: fmt(bb + 0.6), size: 1, layer: 25, align: 'bottom-center' }, [], '>NAME'));
  parts.push(valT ? textEl(valT, 27, true, '>VALUE') : el('text', { x: 0, y: fmt(-bb - 1.6), size: 1, layer: 27, align: 'bottom-center' }, [], '>VALUE'));
  if (fp.model3d?.length) r.skip('3D model', 'Eagle 3D packages need Fusion 360; the model reference is dropped');
  return { xml: el('package', { name }, parts), padNames };
}

const DIR: Record<string, string> = { no_connect: 'nc', input: 'in', output: 'out', bidirectional: 'io', open_collector: 'oc', open_emitter: 'oc', tri_state: 'hiz', passive: 'pas', power_in: 'pwr', power_out: 'sup', unspecified: 'io' };
function lengthName(l: number, r: Report) {
  const opts: [string, number][] = [['point', 0], ['short', 2.54], ['middle', 5.08], ['long', 7.62]];
  let best = opts[0];
  for (const o of opts) if (Math.abs(o[1] - l) < Math.abs(best[1] - l)) best = o;
  if (Math.abs(best[1] - l) > 0.01) r.approx('pin length', 'Eagle pins only come in 0 / 2.54 / 5.08 / 7.62 mm; lengths are rounded (the connection point is kept)');
  return best[0];
}

/** A symbol unit -> Eagle <symbol>, plus pin-name -> pad numbers (for <connect>). */
function symbolXml(u: { graphics: Graphic[]; pins: Pin[] }, name: string, r: Report): { xml: string; connects: [string, string[]][] } {
  const parts = prims(u.graphics, () => 94, r, false);
  // Eagle pins are identified by name: group stacked pins (same name & position) and make other duplicates unique.
  const groups = new Map<string, { pin: Pin; numbers: string[] }>();
  for (const p of u.pins) {
    const key = `${p.name}|${p.at.x}|${p.at.y}`;
    const g = groups.get(key);
    if (g) g.numbers.push(p.number); else groups.set(key, { pin: p, numbers: [p.number] });
  }
  const used = new Set<string>();
  const connects: [string, string[]][] = [];
  let i = 0;
  for (const { pin, numbers } of groups.values()) {
    const base = nm(pin.name && pin.name !== '~' ? pin.name : pin.number || `P${++i}`);
    let pn = base;
    if (used.has(pn)) { let k = 2; while (used.has(`${base}@${k}`)) k++; pn = `${base}@${k}`; }
    used.add(pn);
    const vis = pin.hidden ? 'off' : 'both';
    const fn = pin.shape === 'inverted' ? 'dot' : pin.shape === 'clock' ? 'clk' : pin.shape === 'inverted_clock' ? 'dotclk' : undefined;
    parts.push(el('pin', { name: pn, x: pin.at.x, y: pin.at.y, visible: vis === 'both' ? undefined : vis, length: lengthName(pin.length, r), direction: DIR[pin.type] ?? 'io', function: fn, rot: `R${fmt(normAngle(Math.round(pin.angle / 90) * 90))}` }));
    connects.push([pn, numbers.filter(Boolean)]);
  }
  const ys = u.pins.map(p => p.at.y).concat(u.graphics.flatMap(g => g.type === 'rect' ? [g.a.y, g.b.y] : g.type === 'poly' ? g.pts.map(p => p.y) : []));
  const xs = u.pins.map(p => p.at.x).concat(u.graphics.flatMap(g => g.type === 'rect' ? [g.a.x, g.b.x] : []));
  const top = ys.length ? Math.max(...ys) : 2.54, bot = ys.length ? Math.min(...ys) : -2.54, left = xs.length ? Math.min(...xs) : 0;
  parts.push(el('text', { x: left, y: fmt(top + 1.27), size: 1.778, layer: 95 }, [], '>NAME'));
  parts.push(el('text', { x: left, y: fmt(bot - 3.048), size: 1.778, layer: 96 }, [], '>VALUE'));
  return { xml: el('symbol', { name }, parts), connects };
}

function libraryXml(lib: Library, r: Report, libName: string): { xml: string; pkgNames: Map<Footprint, string> } {
  const pkgUsed = new Set<string>();
  const pkgs: string[] = [];
  const pkgNames = new Map<Footprint, string>();
  const padMaps = new Map<string, Map<string, string[]>>();
  for (const fp of lib.footprints) {
    const name = uniqueName(nm(fp.name), pkgUsed);
    const { xml, padNames } = packageXml(fp, name, r);
    pkgs.push(xml); pkgNames.set(fp, name); padMaps.set(fp.name, padNames); padMaps.set(name, padNames);
    r.ok('footprint');
  }
  const syms: string[] = [];
  const sets: string[] = [];
  const symUsed = new Set<string>(), setUsed = new Set<string>();
  for (const s of lib.symbols) {
    const setName = uniqueName(nm(s.name), setUsed);
    const gates: string[] = [];
    const connects: string[] = [];
    const fpName = s.footprint?.replace(/^.*:/, '');
    const fp = lib.footprints.find(f => f.name === fpName) ?? (lib.footprints.length === 1 && lib.symbols.length === 1 ? lib.footprints[0] : undefined);
    const padMap = fp ? padMaps.get(fp.name) : undefined;
    s.units.forEach((u, i) => {
      const symName = uniqueName(nm(s.units.length > 1 ? `${s.name}_${u.name ?? String.fromCharCode(65 + i)}` : s.name), symUsed);
      const { xml, connects: cs } = symbolXml(u, symName, r);
      syms.push(xml);
      const gate = s.units.length > 1 ? (u.name && !/^\d+$/.test(u.name) ? nm(u.name) : String.fromCharCode(65 + i)) : 'G$1';
      gates.push(el('gate', { name: gate, symbol: symName, x: fmt(i * 25.4), y: 0, addlevel: s.power ? 'request' : undefined }));
      if (padMap) for (const [pin, nums] of cs) {
        const pads = nums.flatMap(nn => padMap.get(nn) ?? []);
        if (pads.length) connects.push(el('connect', { gate, pin, pad: pads.join(' ') }));
        else r.approx('unconnected pin', `pin ${pin} of ${s.name} has no matching pad in ${fp!.name}`);
      }
    });
    if (s.footprint && !fp) r.approx('footprint link', `${s.name}: footprint ${s.footprint} is not in this library, the Eagle device has no package`);
    const techs: string[] = Object.entries(s.properties).filter(([k, v]) => v && /^[A-Za-z_][\w-]*$/.test(k.replace(/\s+/g, '_'))).map(([k, v]) => el('attribute', { name: k.replace(/\s+/g, '_').toUpperCase(), value: v, constant: 'no' }));
    const device = el('device', { name: '', package: fp ? pkgNames.get(fp) : undefined }, [
      fp ? el('connects', {}, connects) : null,
      el('technologies', {}, [el('technology', { name: '' }, techs)]),
    ]);
    sets.push(el('deviceset', { name: setName, prefix: s.power ? 'SUPPLY' : s.reference.replace(/[^A-Za-z_$#]/g, '') || 'U', uservalue: s.power ? undefined : 'yes' }, [
      s.description || s.datasheet ? el('description', {}, [], [s.description, s.datasheet].filter(Boolean).join('\n')) : null,
      el('gates', {}, gates), el('devices', {}, [device]),
    ]));
    r.ok('symbol');
  }
  return {
    xml: el('library', { name: libName }, [el('description', {}, [], `Converted with eda-format-converter`), el('packages', {}, pkgs), el('symbols', {}, syms), el('devicesets', {}, sets)]),
    pkgNames,
  };
}

export function writeEagleLbr(lib: Library, r = new Report(), name = 'converted'): string {
  return header() + '\n' + libraryXml(lib, r, nm(name)).xml + '\n' + footer;
}

export function writeEagleBoard(b: Board, r = new Report()): string {
  const inner = b.copperLayers - 2;
  if (inner > 14) r.approx('copper layers', 'Eagle supports at most 16 copper layers');
  const cuLayer = (l: string) => { const m = /^In(\d+)\.Cu$/.exec(l); return l === 'F.Cu' ? 1 : l === 'B.Cu' ? 16 : m ? Math.min(15, +m[1] + 1) : kicadLayerToEagle(l); };
  // packages: unflip bottom-side footprints back to their top-side definition
  const lib: Library = { symbols: [], footprints: [] };
  const fpOf = new Map<number, Footprint>();
  const byKey = new Map<string, Footprint>();
  b.footprints.forEach((f, i) => {
    const top = f.side === 'bottom' ? mirrorFootprintX(f.footprint) : f.footprint;
    const clean: Footprint = { ...top, pads: top.pads.map(p => ({ ...p, net: undefined })) };
    const key = JSON.stringify(clean);
    let fp = byKey.get(key);
    if (!fp) { fp = clean; byKey.set(key, fp); lib.footprints.push(fp); }
    fpOf.set(i, fp);
  });
  const sub = new Report();
  const { xml: libXml, pkgNames } = libraryXml(lib, sub, 'converted');
  for (const e of sub.list()) if (e.severity !== 'converted') for (const n of e.notes) (e.severity === 'approximated' ? r.approx(e.kind, n) : r.skip(e.kind, n));

  const plain: string[] = [];
  plain.push(...prims(b.graphics, g => cuLayer(g.layer), r));
  for (const h of b.holes) { const p = up(h.at); plain.push(el('hole', { x: p.x, y: p.y, drill: h.d })); }
  for (const z of b.zones.filter(z => z.keepout)) plain.push(el('polygon', { width: 0.1, layer: z.layer === 'B.Cu' ? 42 : 41 }, z.outline.map(p => el('vertex', { x: up(p).x, y: up(p).y }))));

  const elements: string[] = [];
  const signals = new Map<string, string[]>();
  const sig = (n: string) => { let s = signals.get(n); if (!s) { s = []; signals.set(n, s); } return s; };
  const refUsed = new Set<string>();
  b.footprints.forEach((f, i) => {
    const fp = fpOf.get(i)!;
    const name = uniqueName(nm(f.ref || `X${i + 1}`), refUsed);
    const at = up(f.at);
    // MRθ = rotate by θ, then mirror; our bottom parts are stored as mirror-then-rotate, hence the sign flip
    const rot = `${f.side === 'bottom' ? 'M' : ''}R${fmt(normAngle(f.side === 'bottom' ? -f.rotation : f.rotation))}`;
    const attrs: string[] = [];
    for (const t of f.texts ?? []) {
      if (t.role !== 'reference' && t.role !== 'value') continue;
      const w = up(add(f.at, rotDown(t.at, f.rotation)));
      const bottom = t.layer.startsWith('B.');
      attrs.push(el('attribute', { name: t.role === 'reference' ? 'NAME' : 'VALUE', x: w.x, y: w.y, size: t.size, ratio: t.width && t.size ? Math.round(Math.min(31, (t.width / t.size) * 100)) : undefined, layer: t.role === 'reference' ? (bottom ? 26 : 25) : (bottom ? 28 : 27), rot: `${bottom ? 'M' : ''}R${fmt(normAngle(t.rotation + f.rotation))}`, align: 'center', display: t.hidden ? 'off' : undefined }));
    }
    elements.push(el('element', { name, library: 'converted', package: pkgNames.get(fp)!, value: f.value || fp.name, x: at.x, y: at.y, rot: rot === 'R0' ? undefined : rot, locked: f.locked ? 'yes' : undefined, smashed: attrs.length ? 'yes' : undefined }, attrs));
    // contact refs use the (possibly suffixed) Eagle pad names, in order
    const padNameList: string[] = [];
    let mp = 0;
    const used = new Set<string>();
    for (const p of fp.pads) {
      const base = p.number ? nm(p.number) : `MP${++mp}`;
      padNameList.push(uniqueName(base, used));
    }
    f.footprint.pads.forEach((p, k) => { if (p.net) sig(p.net).push(el('contactref', { element: name, pad: padNameList[k] })); });
    r.ok('footprint');
  });
  for (const t of b.tracks) {
    const a = up(t.a), c = up(t.b);
    let curve: string | undefined;
    if (t.mid) { const s = arcSweep(a, up(t.mid), c); if (s) curve = fmt(s.sweep); }
    const w = el('wire', { x1: a.x, y1: a.y, x2: c.x, y2: c.y, width: t.width, layer: cuLayer(t.layer), curve });
    if (t.net) sig(t.net).push(w); else plain.push(w);
  }
  r.ok('track', b.tracks.length);
  for (const v of b.vias) {
    const p = up(v.at);
    const ext = `${cuLayer(v.from ?? 'F.Cu')}-${cuLayer(v.to ?? 'B.Cu')}`.split('-').map(Number).sort((x, y) => x - y).join('-');
    sig(v.net ?? `N$VIA${fmt(p.x)}_${fmt(p.y)}`).push(el('via', { x: p.x, y: p.y, extent: ext, drill: v.drill, diameter: v.size }));
  }
  r.ok('via', b.vias.length);
  for (const z of b.zones.filter(z => !z.keepout)) {
    const poly = el('polygon', { width: z.minWidth ?? 0.254, layer: cuLayer(z.layer), isolate: z.clearance, rank: z.priority ? Math.max(1, 6 - z.priority) : undefined }, z.outline.map(p => el('vertex', { x: up(p).x, y: up(p).y })));
    if (z.net) sig(z.net).push(poly); else { sig(`N$ZONE${signals.size}`).push(poly); r.approx('unconnected zone', 'zones without a net get a dummy signal'); }
  }
  r.ok('zone', b.zones.length);
  const sigXml = [...signals.entries()].map(([n, items]) => el('signal', { name: nm(n) }, items));
  const board = el('board', {}, [
    el('plain', {}, plain), el('libraries', {}, [libXml]), el('attributes'), el('variantdefs'),
    el('classes', {}, [el('class', { number: 0, name: 'default', width: 0, drill: 0 })]),
    el('designrules', { name: 'default' }, [el('param', { name: 'layerSetup', value: inner > 0 ? `(1*${Array.from({ length: inner }, (_, i) => i + 2).join('*')}*16)` : '(1*16)' })]),
    el('elements', {}, elements), el('signals', {}, sigXml),
  ]);
  return header() + '\n' + board + '\n' + footer;
}
