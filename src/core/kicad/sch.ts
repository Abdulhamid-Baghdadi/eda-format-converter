/** KiCad schematics (.kicad_sch, KiCad 6–10): read and write. */
import { parseSExpr, find, findAll, num, str, val, xy, flag, isList, head, q, writeSExpr, type SList, type W } from './sexpr';
import { readSymbolList, readGraphic } from './read';
import { symbolSExpr, effects, kicadName, GENERATOR } from './write';
import type { Schematic, Sheet, SymbolInstance, Text, Symbol } from '../model';
import { normAngle } from '../geom';
import { junctionPoints, placeSym } from '../sch';
import { Report } from '../report';

const VERSION_SCH = 20231120;

export const emptySheet = (name: string): Sheet => ({ name, symbols: [], wires: [], buses: [], junctions: [], noConnects: [], labels: [], graphics: [] });

function readProp(p: SList): Text {
  const at = find(p, 'at');
  const eff = find(p, 'effects');
  const font = eff && find(eff, 'font');
  const size = font ? num(find(font, 'size')?.[1], 1.27) : 1.27;
  const just = eff && find(eff, 'justify');
  const js = just ? just.slice(1).map(String) : [];
  return {
    type: 'text', at: xy(at), rotation: num(at?.[3]), text: str(p[2]) ?? '', size, width: 0, layer: 'symbol',
    hidden: flag(p, 'hide') || (eff ? flag(eff, 'hide') : false), justify: js.includes('left') ? 'left' : js.includes('right') ? 'right' : 'center',
  };
}

/** Read one .kicad_sch file into a sheet, adding its symbol definitions to `symbols`. */
export function readKicadSheet(src: string, symbols: Record<string, Symbol>, r: Report, name: string): Sheet {
  const root = parseSExpr(src)[0] as SList;
  if (head(root) !== 'kicad_sch') throw new Error('Not a KiCad schematic (.kicad_sch)');
  const sh = emptySheet(name);
  const libs = find(root, 'lib_symbols');
  if (libs) {
    const byName = new Map<string, SList>();
    for (const s of findAll(libs, 'symbol')) byName.set(str(s[1])!, s);
    for (const s of findAll(libs, 'symbol')) { const sym = readSymbolList(s, byName, new Report()); symbols[str(s[1])!] = sym; }
  }
  for (const c of root) {
    if (!isList(c)) continue;
    const h = head(c)!;
    if (h === 'symbol') {
      const at = find(c, 'at');
      const props: Record<string, string> = {};
      const texts: Record<string, Text> = {};
      for (const p of findAll(c, 'property')) { props[str(p[1])!] = str(p[2]) ?? ''; texts[str(p[1])!] = readProp(p); }
      // hierarchical designs keep the real reference in the instances block
      let ref = props.Reference ?? '';
      const inst = find(c, 'instances');
      if (inst && (!ref || ref.endsWith('?'))) {
        const proj = find(inst, 'project');
        const path = proj && find(proj, 'path');
        const rr = path && str(val(path, 'reference'));
        if (rr) ref = rr;
      }
      const lib = str(val(c, 'lib_name')) ?? str(val(c, 'lib_id')) ?? '';
      const mirror = str(val(c, 'mirror'));
      const { Reference, Value, Footprint, ...rest } = props;
      void Reference;
      const si: SymbolInstance = {
        ref, value: Value ?? '', footprint: Footprint || undefined, lib, unit: num(val(c, 'unit'), 1), at: xy(at), rotation: normAngle(num(at?.[3])),
        mirror: mirror === 'x' || mirror === 'y' ? mirror : undefined, refText: texts.Reference, valueText: texts.Value, properties: rest,
      };
      delete si.properties.Datasheet; delete si.properties.Description;
      sh.symbols.push(si);
      r.ok(symbols[lib]?.power ? 'power symbol' : 'symbol instance');
    } else if (h === 'wire' || h === 'bus') {
      const pts = (find(c, 'pts') ?? []).slice(1).filter(isList).map(xy);
      for (let i = 1; i < pts.length; i++) (h === 'wire' ? sh.wires : sh.buses).push({ a: pts[i - 1], b: pts[i] });
      r.ok(h);
    } else if (h === 'junction') { sh.junctions.push(xy(find(c, 'at'))); r.ok('junction'); }
    else if (h === 'no_connect') { sh.noConnects.push(xy(find(c, 'at'))); r.ok('no-connect'); }
    else if (h === 'label' || h === 'global_label' || h === 'hierarchical_label') {
      const at = find(c, 'at');
      sh.labels.push({ text: str(c[1]) ?? '', at: xy(at), rotation: num(at?.[3]), kind: h === 'label' ? 'local' : h === 'global_label' ? 'global' : 'hier' });
      if (h === 'hierarchical_label') r.approx('hierarchical label', 'hierarchical labels are treated as global labels (sheets are flattened)');
      r.ok('label');
    } else if (h === 'text') {
      const t = readGraphic(c, '', r, 'Notes');
      if (t?.type === 'text') { t.rotation = normAngle(t.rotation); sh.graphics.push(t); r.ok('text'); }
    } else if (['polyline', 'rectangle', 'circle', 'arc'].includes(h)) {
      const g = readGraphic(c, '', r, 'Notes');
      if (g) { sh.graphics.push(g); r.ok('drawing'); }
    } else if (h === 'sheet') {
      // sheet pins connect the parent's wires to the child's hierarchical labels of the same name
      for (const p of findAll(c, 'pin')) { const at = find(p, 'at'); sh.labels.push({ text: str(p[1]) ?? '', at: xy(at), rotation: num(at?.[3]), kind: 'hier' }); }
      const file = findAll(c, 'property').find(p => /^Sheet ?file$/i.test(str(p[1]) ?? ''));
      sh.subsheets = [...(sh.subsheets ?? []), str(file?.[2]) ?? ''];
      r.ok('sheet symbol');
    }
    else if (h === 'bus_entry') r.skip('bus entry', 'bus entries are not converted');
    else if (h === 'netclass_flag' || h === 'directive_label') r.skip(h, 'not converted');
    else if (h === 'image') r.skip('image', 'images are not converted');
  }
  return sh;
}

export function readKicadSchematic(files: { name: string; src: string }[], r = new Report(), name = 'schematic'): Schematic {
  const symbols: Record<string, Symbol> = {};
  const sheets = files.map(f => readKicadSheet(f.src, symbols, r, f.name.replace(/^.*[\\/]/, '').replace(/\.kicad_sch$/i, '')));
  const base = (f: string) => f.replace(/^.*[\\/]/, '').toLowerCase();
  const have = new Set(files.map(f => base(f.name)));
  const refs = sheets.flatMap(s => s.subsheets ?? []).filter(Boolean);
  const missing = [...new Set(refs)].filter(f => !have.has(base(f)));
  if (missing.length) r.skip('missing sub-sheet', `not included: ${missing.join(', ')} — drop all sheet files together, or a zip of the project folder`, missing.length);
  if (refs.length > new Set(refs).size) r.approx('repeated sheet', 'a sheet used several times is converted once; its hierarchical labels are joined by name');
  for (const s of sheets) delete s.subsheets;
  return { name, symbols, sheets };
}

// ---------------------------------------------------------------- writer
let uuidCounter = 0;
const uuid = (seed: string) => {
  // deterministic UUID-shaped ids, so the same input always gives the same file
  let h = 0x811c9dc5;
  const s = `${seed}#${uuidCounter++}`;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  const hex = (n: number) => (n >>> 0).toString(16).padStart(8, '0');
  const a = hex(h), b = hex(Math.imul(h, 2654435761)), c = hex(h ^ 0x5bd1e995), d = hex(Math.imul(h ^ uuidCounter, 40503));
  return `${a}-${b.slice(0, 4)}-4${b.slice(5, 8)}-8${c.slice(1, 4)}-${c.slice(4)}${d}`;
};

const PAPER: [string, number, number][] = [['A4', 297, 210], ['A3', 420, 297], ['A2', 594, 420], ['A1', 841, 594], ['A0', 1189, 841]];

/** KiCad wants connection points on its 1.27 mm grid; we keep coordinates as they are (KiCad tolerates off-grid). */
function sheetSExpr(s: Schematic, sh: Sheet, project: string, fileUuid: string, instPath: string, libKey: (k: string) => string, extra: W[] = [], root = true): W {
  const xs = [...sh.symbols.map(x => x.at), ...sh.wires.flatMap(w => [w.a, w.b])];
  const w = xs.length ? Math.max(...xs.map(p => p.x)) : 0, hgt = xs.length ? Math.max(...xs.map(p => p.y)) : 0;
  const paper = PAPER.find(([, pw, ph]) => w < pw - 10 && hgt < ph - 10)?.[0] ?? 'A0';
  const e: W = ['kicad_sch', ['version', VERSION_SCH], ['generator', q(GENERATOR)], ['generator_version', q('1.0')], ['uuid', q(fileUuid)], ['paper', q(paper)]];
  const used = new Set(sh.symbols.map(x => x.lib));
  const libs: W = ['lib_symbols'];
  for (const k of used) if (s.symbols[k]) libs.push(symbolSExpr(s.symbols[k], libKey(k)));
  e.push(libs);
  for (const j of junctionPoints(sh)) e.push(['junction', ['at', j.x, j.y], ['diameter', 0], ['color', 0, 0, 0, 0], ['uuid', q(uuid('j'))]]);
  for (const n of sh.noConnects) e.push(['no_connect', ['at', n.x, n.y], ['uuid', q(uuid('n'))]]);
  for (const wi of sh.wires) e.push(['wire', ['pts', ['xy', wi.a.x, wi.a.y], ['xy', wi.b.x, wi.b.y]], ['stroke', ['width', 0], ['type', 'default']], ['uuid', q(uuid('w'))]]);
  for (const b of sh.buses) e.push(['bus', ['pts', ['xy', b.a.x, b.a.y], ['xy', b.b.x, b.b.y]], ['stroke', ['width', 0], ['type', 'default']], ['uuid', q(uuid('b'))]]);
  for (const l of sh.labels) {
    const rot = normAngle(Math.round(l.rotation / 90) * 90);
    const just = rot === 180 || rot === 270 ? 'right' : 'left';
    if (l.kind === 'local') e.push(['label', q(l.text), ['at', l.at.x, l.at.y, rot], ['fields_autoplaced', 'yes'], ['effects', ['font', ['size', 1.27, 1.27]], ['justify', just, 'bottom']], ['uuid', q(uuid('l'))]]);
    else e.push(['global_label', q(l.text), ['shape', 'bidirectional'], ['at', l.at.x, l.at.y, rot], ['fields_autoplaced', 'yes'], ['effects', ['font', ['size', 1.27, 1.27]], ['justify', just]], ['uuid', q(uuid('g'))],
      true ? ['property', q('Intersheetrefs'), q('${INTERSHEET_REFS}'), ['at', l.at.x, l.at.y, 0], ['effects', ['font', ['size', 1.27, 1.27]], ['hide', 'yes']]] : null]);
  }
  for (const g of sh.graphics) {
    if (g.type === 'text') e.push(['text', q(g.text), ['exclude_from_sim', 'no'], ['at', g.at.x, g.at.y, normAngle(g.rotation)], effects({ size: g.size || 1.27, justify: g.justify }), ['uuid', q(uuid('t'))]]);
    else if (g.type === 'line') e.push(['polyline', ['pts', ['xy', g.a.x, g.a.y], ['xy', g.b.x, g.b.y]], ['stroke', ['width', g.width], ['type', 'default']], ['uuid', q(uuid('p'))]]);
    else if (g.type === 'poly') e.push(['polyline', ['pts', ...(g.closed ? [...g.pts, g.pts[0]] : g.pts).map(p => ['xy', p.x, p.y] as W)], ['stroke', ['width', g.width], ['type', 'default']], ['uuid', q(uuid('p'))]]);
    else if (g.type === 'rect') e.push(['rectangle', ['start', g.a.x, g.a.y], ['end', g.b.x, g.b.y], ['stroke', ['width', g.width], ['type', 'default']], ['fill', ['type', 'none']], ['uuid', q(uuid('p'))]]);
  }
  for (const si of sh.symbols) {
    const def = s.symbols[si.lib];
    const pins = def ? (def.units[si.unit - 1] ?? def.units[0])?.pins ?? [] : [];
    const rot = normAngle(Math.round(si.rotation / 90) * 90);
    const field = (k: string, v: string, t: Text | undefined, dy: number, hide = false): W => {
      const at = t?.at ?? placeSym(si, { x: 2.54, y: dy });
      return ['property', q(k), q(v), ['at', at.x, at.y, t ? normAngle(t.rotation) : 0], effects({ size: t?.size || 1.27, hidden: hide || t?.hidden, justify: t ? t.justify : 'left' })];
    };
    const sym: W = ['symbol', ['lib_id', q(libKey(si.lib))], ['at', si.at.x, si.at.y, rot], si.mirror ? ['mirror', si.mirror] : null, ['unit', si.unit],
      ['exclude_from_sim', 'no'], ['in_bom', def?.power ? 'no' : 'yes'], ['on_board', def?.power ? 'no' : 'yes'], ['dnp', 'no'], ['uuid', q(uuid('s' + si.ref))],
      field('Reference', si.ref, si.refText, 2.54, !!def?.power), field('Value', si.value, si.valueText, -2.54),
      field('Footprint', si.footprint ?? '', undefined, -5.08, true), field('Datasheet', '', undefined, -7.62, true), field('Description', '', undefined, -10.16, true),
      ...Object.entries(si.properties).filter(([k]) => k && !/^(Reference|Value|Footprint|Datasheet|Description)$/i.test(k)).map(([k, v]) => field(k, v, undefined, 0, true)),
      ...pins.map(p => ['pin', q(p.number || p.name), ['uuid', q(uuid('pin'))]] as W),
      ['instances', ['project', q(project), ['path', q(instPath), ['reference', q(si.ref)], ['unit', si.unit]]]]];
    e.push(sym);
  }
  e.push(...extra);
  if (root) e.push(['sheet_instances', ['path', q('/'), ['page', q('1')]]]);
  return e;
}

export function writeKicadSchematic(s: Schematic, r = new Report()): { name: string; data: string }[] {
  uuidCounter = 0;
  const project = kicadName(s.name);
  // library ids: "<project>:<symbol>", made unique and valid
  const keys = new Map<string, string>(), used = new Set<string>();
  for (const k of Object.keys(s.symbols)) {
    let n = kicadName(k.replace(/^.*:/, '')) || 'symbol';
    while (used.has(n)) n += '_';
    used.add(n); keys.set(k, `${project}:${n}`);
  }
  const libKey = (k: string) => keys.get(k) ?? `${project}:${kicadName(k)}`;
  const files: { name: string; data: string }[] = [];
  const rootUuid = uuid('root');
  // the first sheet is the root; any further sheets become sub-sheets of it (connected through global labels)
  const subs: W[] = [];
  s.sheets.slice(1).forEach((sh, i) => {
    const fname = `${project}_${kicadName(sh.name) || `sheet${i + 2}`}.kicad_sch`;
    const subUuid = uuid('sub');
    files.push({ name: fname, data: writeSExpr(sheetSExpr(s, sh, project, uuid('file'), `/${rootUuid}/${subUuid}`, libKey, [], false)) + '\n' });
    subs.push(['sheet', ['at', 20 + i * 40, 20], ['size', 30, 15], ['fields_autoplaced', 'yes'], ['stroke', ['width', 0.1524], ['type', 'solid']], ['fill', ['color', 0, 0, 0, 0]], ['uuid', q(subUuid)],
      ['property', q('Sheetname'), q(sh.name || `Sheet ${i + 2}`), ['at', 20 + i * 40, 19.3, 0], effects({ size: 1.27, justify: 'left' })],
      ['property', q('Sheetfile'), q(fname), ['at', 20 + i * 40, 35.6, 0], effects({ size: 1.27, justify: 'left' })],
      ['instances', ['project', q(project), ['path', q(`/${rootUuid}`), ['page', q(String(i + 2))]]]]]);
    if (sh.labels.some(l => l.kind === 'hier')) r.approx('hierarchical label', 'hierarchical labels on extra sheets connect like global labels');
  });
  const first = s.sheets[0] ?? emptySheet('root');
  files.unshift({ name: `${project}.kicad_sch`, data: writeSExpr(sheetSExpr(s, first, project, rootUuid, `/${rootUuid}`, libKey, subs)) + '\n' });
  r.ok('sheet', s.sheets.length);
  r.ok('symbol instance', s.sheets.reduce((n, x) => n + x.symbols.length, 0));
  r.ok('wire', s.sheets.reduce((n, x) => n + x.wires.length, 0));
  r.ok('label', s.sheets.reduce((n, x) => n + x.labels.length, 0));
  return files;
}
