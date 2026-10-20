/** Eagle schematics (.sch, Eagle 6–9 XML): read and write. Eagle is Y-up; sheets in the model are Y-down. */
import { parseXml, child, children, path, el, fmt, type XNode } from '../xml';
import type { Schematic, Sheet, Symbol, SymbolInstance, Footprint, Library, Pt, Text } from '../model';
import { normAngle } from '../geom';
import { readEagleLibraryNode, parseRot, curveArc } from './read';
import { header, footer, libraryXml, nm, textEl, prims } from './write';
import { sheetNets, instancePins } from '../sch';
import { Report } from '../report';

const f = (s: string | undefined, d = 0) => { const v = parseFloat(s ?? ''); return Number.isFinite(v) ? v : d; };
const down = (x: number, y: number): Pt => ({ x, y: -y });

export function readEagleSchematic(src: string, r = new Report(), name = 'schematic'): Schematic {
  const root = parseXml(src);
  const sch = path(root, 'drawing/schematic');
  if (!sch) throw new Error('Not an Eagle schematic (.sch)');
  const symbols: Record<string, Symbol> = {};
  const index = new Map<string, Symbol>();
  for (const lib of children(child(sch, 'libraries'), 'library')) {
    const li = new Map<string, Symbol>();
    readEagleLibraryNode(lib, new Report(), lib.attrs.name, li);
    for (const [k, s] of li) { const key = `${lib.attrs.name}:${k}`; index.set(key, s); symbols[key] = s; }
  }
  const parts = new Map<string, XNode>();
  for (const p of children(child(sch, 'parts'), 'part')) parts.set(p.attrs.name, p);
  // gate name -> unit index per deviceset
  const gateIndex = new Map<string, Map<string, number>>();
  for (const lib of children(child(sch, 'libraries'), 'library')) for (const ds of children(child(lib, 'devicesets'), 'deviceset')) {
    const m = new Map<string, number>();
    children(child(ds, 'gates'), 'gate').forEach((g, i) => m.set(g.attrs.name, i + 1));
    gateIndex.set(`${lib.attrs.name}:${ds.attrs.name}`, m);
  }
  const sheets: Sheet[] = [];
  children(child(sch, 'sheets'), 'sheet').forEach((shn, si) => {
    const sh: Sheet = { name: `Sheet ${si + 1}`, symbols: [], wires: [], buses: [], junctions: [], noConnects: [], labels: [], graphics: [] };
    for (const inst of children(child(shn, 'instances'), 'instance')) {
      const part = parts.get(inst.attrs.part);
      if (!part) { r.skip('instance', `part ${inst.attrs.part} not found`); continue; }
      const key = `${part.attrs.library}:${part.attrs.deviceset}|${part.attrs.device ?? ''}`;
      const def = index.get(key);
      if (!def) { r.skip('instance', `device ${part.attrs.deviceset}${part.attrs.device ?? ''} not found`); continue; }
      const rot = parseRot(inst.attrs.rot);
      const unit = gateIndex.get(`${part.attrs.library}:${part.attrs.deviceset}`)?.get(inst.attrs.gate) ?? 1;
      const props: Record<string, string> = {};
      for (const a of children(part, 'attribute')) if (a.attrs.value) props[a.attrs.name] = a.attrs.value;
      const si2: SymbolInstance = {
        // SUPPLY_x parts are our encoding of KiCad's '#'-references (power and flag symbols)
        ref: part.attrs.name.replace(/^SUPPLY_/, '#'), value: part.attrs.value ?? (def.power ? def.units[0]?.pins[0]?.name ?? def.name : def.name), lib: key, unit,
        at: down(f(inst.attrs.x), f(inst.attrs.y)), rotation: normAngle(rot.angle), mirror: rot.mirror ? 'y' : undefined,
        footprint: def.footprint, properties: props,
      };
      for (const a of children(inst, 'attribute')) {
        if (a.attrs.x === undefined) continue;
        const t: Text = { type: 'text', at: down(f(a.attrs.x), f(a.attrs.y)), text: '', size: f(a.attrs.size, 1.778), width: 0, rotation: normAngle(parseRot(a.attrs.rot).angle), layer: 'symbol', justify: 'left', hidden: a.attrs.display === 'off' };
        if (a.attrs.name === 'NAME') si2.refText = t; else if (a.attrs.name === 'VALUE') si2.valueText = t;
      }
      sh.symbols.push(si2);
      r.ok(def.power ? 'power symbol' : 'symbol instance');
    }
    for (const net of children(child(shn, 'nets'), 'net')) {
      const named = !/^N\$\d+$/.test(net.attrs.name);
      for (const seg of children(net, 'segment')) {
        const ends: Pt[] = [];
        for (const w of children(seg, 'wire')) {
          const a = down(f(w.attrs.x1), f(w.attrs.y1)), b = down(f(w.attrs.x2), f(w.attrs.y2));
          if (f(w.attrs.curve)) r.approx('curved wire', 'curved net wires become straight');
          sh.wires.push({ a, b }); ends.push(a, b);
        }
        for (const j of children(seg, 'junction')) sh.junctions.push(down(f(j.attrs.x), f(j.attrs.y)));
        let labelled = false;
        for (const l of children(seg, 'label')) {
          // Eagle labels float near the wire; anchor ours on the closest wire end so it connects
          const p = down(f(l.attrs.x), f(l.attrs.y));
          const at = ends.length ? ends.reduce((b, e) => (Math.hypot(e.x - p.x, e.y - p.y) < Math.hypot(b.x - p.x, b.y - p.y) ? e : b)) : p;
          sh.labels.push({ text: net.attrs.name, at, rotation: normAngle(parseRot(l.attrs.rot).angle), kind: l.attrs.xref === 'yes' ? 'global' : 'local' });
          labelled = true;
        }
        // Eagle nets are named globally: keep the name on every segment so separate pieces stay joined
        // (not needed where a supply symbol on this segment already names the net)
        const hasSupply = children(seg, 'pinref').some(pr => { const pp = parts.get(pr.attrs.part); return !!pp && !!index.get(`${pp.attrs.library}:${pp.attrs.deviceset}|${pp.attrs.device ?? ''}`)?.power; });
        if (named && !labelled && !hasSupply && ends.length) sh.labels.push({ text: net.attrs.name, at: ends[0], rotation: 0, kind: 'global' });
        // a pin that the net references but no wire touches still belongs to the net
        for (const pr of children(seg, 'pinref')) {
          const prt = parts.get(pr.attrs.part);
          const unit = prt ? gateIndex.get(`${prt.attrs.library}:${prt.attrs.deviceset}`)?.get(pr.attrs.gate) ?? 1 : 1;
          const inst = sh.symbols.find(x => x.ref === pr.attrs.part.replace(/^SUPPLY_/, '#') && x.unit === unit);
          if (!inst) continue;
          const pin = instancePins({ name, symbols, sheets: [] }, inst).find(x => x.pin.name === pr.attrs.pin.replace(/@\d+$/, '') || x.pin.name === pr.attrs.pin);
          if (pin && !index.get(inst.lib)?.power && !ends.some(e => Math.abs(e.x - pin.at.x) < 0.01 && Math.abs(e.y - pin.at.y) < 0.01)) sh.labels.push({ text: net.attrs.name, at: pin.at, rotation: 0, kind: named ? 'global' : 'local' });
        }
        r.ok('net segment');
      }
    }
    for (const b of children(child(shn, 'busses'), 'bus')) for (const seg of children(b, 'segment')) for (const w of children(seg, 'wire')) sh.buses.push({ a: down(f(w.attrs.x1), f(w.attrs.y1)), b: down(f(w.attrs.x2), f(w.attrs.y2)) });
    const plain = child(shn, 'plain');
    if (plain) for (const c of plain.children) {
      if (c.tag === 'text') { sh.graphics.push({ type: 'text', at: down(f(c.attrs.x), f(c.attrs.y)), text: c.text, size: f(c.attrs.size, 1.778), width: 0, rotation: normAngle(parseRot(c.attrs.rot).angle), layer: 'Notes', justify: 'left' }); r.ok('text'); }
      else if (c.tag === 'wire') {
        const a = down(f(c.attrs.x1), f(c.attrs.y1)), b = down(f(c.attrs.x2), f(c.attrs.y2));
        if (f(c.attrs.curve)) { const arc = curveArc({ x: a.x, y: -a.y }, { x: b.x, y: -b.y }, f(c.attrs.curve)); sh.graphics.push({ type: 'arc', start: a, mid: { x: arc.mid.x, y: -arc.mid.y }, end: b, width: f(c.attrs.width), layer: 'Notes' }); }
        else sh.graphics.push({ type: 'line', a, b, width: f(c.attrs.width), layer: 'Notes' });
        r.ok('drawing');
      } else if (c.tag === 'frame') r.skip('frame', 'drawing frames are not converted');
    }
    sheets.push(sh);
  });
  return { name, symbols, sheets };
}

// ---------------------------------------------------------------- writer
const up = (p: Pt) => ({ x: p.x, y: -p.y });
/** Eagle part names: no spaces; KiCad's '#PWR01'-style power references become SUPPLY_PWR01. */
const partName = (ref: string) => nm(ref.replace(/^#/, 'SUPPLY_'));

/** Placeholder package for a device whose real footprint is not part of the schematic: one pad per pin number. */
function placeholder(def: Symbol, name: string): Footprint {
  const nums = [...new Set(def.units.flatMap(u => u.pins.map(p => p.number)).filter(Boolean))];
  return { name, pads: nums.map((n, i) => ({ number: n, kind: 'smd', shape: 'rect', at: { x: i * 1.27, y: 0 }, rotation: 0, w: 0.6, h: 0.6, side: 'F' })), graphics: [] };
}

export function writeEagleSchematic(s: Schematic, r = new Report()): string {
  // library: every definition; devices with pin numbers get a package so the numbers survive (Eagle keeps them as pads)
  const keys = Object.keys(s.symbols);
  const lib: Library = { symbols: [], footprints: [] };
  const defOf = new Map<string, Symbol>();
  const pkgUsed = new Set<string>();
  let placeholders = 0;
  for (const k of keys) {
    const def = s.symbols[k];
    const copy: Symbol = { ...def };
    const hasNumbers = def.units.some(u => u.pins.some(p => p.number && p.number !== p.name)) && !def.power;
    if (hasNumbers) {
      let pk = nm(def.footprint?.replace(/^.*:/, '') || `${def.name}_PINS`);
      while (pkgUsed.has(pk)) pk += '_';
      pkgUsed.add(pk);
      lib.footprints.push(placeholder(def, pk));
      copy.footprint = pk;
      placeholders++;
    } else copy.footprint = undefined;
    lib.symbols.push(copy);
    defOf.set(k, copy);
  }
  if (placeholders) r.approx('placeholder package', 'Eagle keeps pin numbers on packages: devices get a placeholder package named after their footprint (replace it with the real one in Eagle)');
  const { xml: libXml, symInfo } = libraryXml(lib, new Report(), 'converted');
  const partsXml: string[] = [];
  const seenParts = new Set<string>();
  const sheetsXml: string[] = [];
  const nets = sheetNets(s);
  // one Eagle part = one device: units of the same reference must share a definition
  const partLib = new Map<string, string>(), partOf = new Map<SymbolInstance, string>();
  const shape = (k: string) => JSON.stringify(s.symbols[k]?.units.map(u => u.pins.map(p => [p.number, p.name, p.at.x, p.at.y])));
  for (const sh of s.sheets) for (const x of sh.symbols) {
    let name = partName(x.ref || 'X');
    let n = 2;
    while (partLib.has(name) && partLib.get(name) !== x.lib && shape(partLib.get(name)!) !== shape(x.lib)) { name = partName(`${x.ref}_${n++}`); r.approx('split part', `${x.ref}: units use different symbols, so they become separate Eagle parts`); }
    if (!partLib.has(name)) partLib.set(name, x.lib);
    partOf.set(x, name);
  }
  s.sheets.forEach((sh, si) => {
    const inst: string[] = [];
    sh.symbols.forEach(x => {
      const part = partOf.get(x)!;
      const def = defOf.get(partLib.get(part)!)!;
      const info = symInfo.get(def);
      if (!info) return;
      if (!seenParts.has(part)) {
        seenParts.add(part);
        partsXml.push(el('part', { name: part, library: 'converted', deviceset: info.set, device: '', value: x.value || undefined }));
      }
      const rot = `${x.mirror ? 'M' : ''}R${fmt(normAngle(x.mirror === 'x' ? x.rotation + 180 : x.rotation))}`;
      const at = up(x.at);
      const attrs: string[] = [];
      for (const [t, n, layer] of [[x.refText, 'NAME', 95], [x.valueText, 'VALUE', 96]] as const) if (t) { const p = up(t.at); attrs.push(el('attribute', { name: n, x: p.x, y: p.y, size: t.size || 1.778, layer, rot: `R${fmt(normAngle(t.rotation))}`, display: t.hidden ? 'off' : undefined })); }
      inst.push(el('instance', { part, gate: info.gates[x.unit - 1] ?? info.gates[0], x: at.x, y: at.y, rot: rot === 'R0' ? undefined : rot, smashed: attrs.length ? 'yes' : undefined }, attrs));
      r.ok('symbol instance');
    });
    if (sh.symbols.some(x => x.mirror === 'x')) r.info('Eagle mirrors left/right only: top/bottom-mirrored symbols are written as mirrored and turned 180°.');
    const netXml = nets[si].map(n => {
      const items: string[] = [];
      for (const p of n.pins) {
        const x = sh.symbols[p.inst];
        const def = defOf.get(partLib.get(partOf.get(x)!)!)!;
        const info = symInfo.get(def);
        // the shared definition has the same pins in the same order as this instance's own definition
        const own = s.symbols[x.lib].units[x.unit - 1]?.pins ?? [];
        const idx = own.indexOf(p.pin);
        const pin = idx >= 0 ? def.units[x.unit - 1]?.pins[idx] ?? p.pin : p.pin;
        const pn = info?.pinNames.get(pin);
        if (!pn) continue;
        items.push(el('pinref', { part: partOf.get(x)!, gate: info!.gates[x.unit - 1] ?? info!.gates[0], pin: pn }));
      }
      for (const wi of n.wires) { const w = sh.wires[wi]; const a = up(w.a), b = up(w.b); items.push(el('wire', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, width: 0.1524, layer: 91 })); }
      for (const j of n.junctions) { const p = up(j); items.push(el('junction', { x: p.x, y: p.y })); }
      for (const li of n.labels) { const l = sh.labels[li]; const p = up(l.at); items.push(el('label', { x: p.x, y: p.y, size: 1.778, layer: 95, rot: l.rotation ? `R${fmt(normAngle(l.rotation))}` : undefined, xref: l.kind !== 'local' ? 'yes' : undefined })); }
      return el('net', { name: nm(n.name), class: 0 }, [el('segment', {}, items)]);
    });
    const plain = prims(sh.graphics.filter(g => g.type !== 'text'), () => 97, r);
    for (const g of sh.graphics) if (g.type === 'text') plain.push(textEl(g, 97));
    if (sh.buses.length) r.skip('bus', 'buses are drawn only; their member nets keep their own names');
    if (sh.noConnects.length) r.approx('no-connect', 'Eagle has no no-connect marker; it is dropped', sh.noConnects.length);
    sheetsXml.push(el('sheet', {}, [el('plain', {}, plain), el('instances', {}, inst), el('busses'), el('nets', {}, netXml)]));
    r.ok('sheet');
  });
  const schematic = el('schematic', { xreflabel: '%F%N/%S.%C%R', xrefpart: '/%S.%C%R' }, [
    el('libraries', {}, [libXml]), el('attributes'), el('variantdefs'),
    el('classes', {}, [el('class', { number: 0, name: 'default', width: 0, drill: 0 })]),
    el('parts', {}, partsXml), el('sheets', {}, sheetsXml),
  ]);
  return header() + '\n' + schematic + '\n' + footer;
}
