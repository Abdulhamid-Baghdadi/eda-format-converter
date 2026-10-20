/**
 * Builds the demo board shipped with the web app and used by the tests.
 * It uses footprints from the official KiCad library (CC-BY-SA 4.0 with the design exception:
 * boards made from them may be distributed freely). Run: npm run samples (needs KiCad installed).
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { readKicadFootprint, placeDown } from '../src/core/kicad/read';
import { writeKicadPcb } from '../src/core/kicad/write';
import { writeDesign, readFile } from '../src/core/index';
import { arcFromCenter, mapPt } from '../src/core/geom';
import type { Board, PlacedFootprint, Pt, Track } from '../src/core/model';

const FP = process.env.KICAD_FOOTPRINTS ?? 'C:/Program Files/KiCad/10.0/share/kicad/footprints/';
const OUT = 'public/samples/';
mkdirSync(OUT, { recursive: true });

const parts: [string, string, string, number, number, number, 'top' | 'bottom'][] = [
  ['U1', 'NE555', 'Package_SO.pretty/SOIC-8_3.9x4.9mm_P1.27mm', 22, 16, 0, 'top'],
  ['R1', '10k', 'Resistor_SMD.pretty/R_0805_2012Metric', 30, 10, 90, 'top'],
  ['R2', '47k', 'Resistor_SMD.pretty/R_0805_2012Metric', 30, 16, 90, 'top'],
  ['C1', '10uF', 'Capacitor_SMD.pretty/C_0805_2012Metric', 14, 20, 90, 'top'],
  ['C2', '10nF', 'Capacitor_SMD.pretty/C_0805_2012Metric', 30, 22, 90, 'top'],
  ['R3', '470', 'Resistor_SMD.pretty/R_0805_2012Metric', 14, 12, 0, 'top'],
  ['D1', 'red', 'LED_SMD.pretty/LED_0805_2012Metric', 8, 12, 90, 'top'],
  ['J1', 'PWR', 'Connector_PinHeader_2.54mm.pretty/PinHeader_1x02_P2.54mm_Vertical', 39, 14.73, 0, 'top'],
  ['C3', '100nF', 'Capacitor_SMD.pretty/C_0603_1608Metric', 22, 22, 45, 'bottom'],
];
const nets: Record<string, string[]> = {
  VCC: ['J1.1', 'U1.8', 'U1.4', 'R1.2', 'C3.1'],
  GND: ['J1.2', 'U1.1', 'C1.1', 'C2.1', 'D1.1', 'C3.2'],
  DIS: ['U1.7', 'R1.1', 'R2.2'],
  THR: ['U1.6', 'U1.2', 'R2.1', 'C1.2'],
  CTRL: ['U1.5', 'C2.2'],
  OUT: ['U1.3', 'R3.2'],
  LED_A: ['R3.1', 'D1.2'],
};
const netOf = (ref: string, pad: string) => Object.entries(nets).find(([, v]) => v.includes(`${ref}.${pad}`))?.[0];
const flipY = (p: Pt) => ({ x: p.x, y: -p.y });

const footprints: PlacedFootprint[] = parts.map(([ref, value, path, x, y, rot, side]) => {
  let fp = readKicadFootprint(readFileSync(FP + path + '.kicad_mod', 'utf8'));
  fp = { ...fp, model3d: undefined, graphics: fp.graphics.filter(g => g.type !== 'text') };
  if (side === 'bottom') {
    // KiCad flips bottom-side footprints top-to-bottom in local coordinates
    fp = {
      ...fp,
      pads: fp.pads.map(p => ({ ...p, at: flipY(p.at), rotation: -p.rotation, side: 'B' as const })),
      graphics: fp.graphics.map(g => ({ ...mapPt(g, flipY), layer: g.layer.replace(/^F\./, 'B.') })),
    };
  }
  fp.pads.forEach(p => (p.net = netOf(ref, p.number)));
  const silk = side === 'bottom' ? 'B.SilkS' : 'F.SilkS', fab = side === 'bottom' ? 'B.Fab' : 'F.Fab';
  return {
    ref, value, at: { x, y }, rotation: rot, side, footprint: fp,
    texts: [
      { type: 'text', role: 'reference', text: ref, at: { x: 0, y: ref === 'U1' ? -3.4 : ref === 'J1' ? -2.9 : -1.6 }, size: 0.8, width: 0.12, rotation: 0, layer: silk, mirror: side === 'bottom' },
      { type: 'text', role: 'value', text: value, at: { x: 0, y: 1.6 }, size: 0.8, width: 0.12, rotation: 0, layer: fab, mirror: side === 'bottom' },
    ],
  };
});
const padAt = (id: string) => { const [ref, n] = id.split('.'); const f = footprints.find(x => x.ref === ref)!; return placeDown(f, f.footprint.pads.find(p => p.number === n)!.at); };

const tracks: Track[] = [];
const route = (net: string, layer: string, w: number, ...pts: (Pt | string)[]) => {
  const ps = pts.map(p => (typeof p === 'string' ? padAt(p) : p));
  for (let i = 1; i < ps.length; i++) tracks.push({ layer, width: w, a: ps[i - 1], b: ps[i], net });
};
const P = (x: number, y: number) => ({ x, y });
route('VCC', 'F.Cu', 0.5, 'J1.1', P(36, 14.73), P(36, 8), P(26.5, 8), P(26.5, 14.095), 'U1.8');
route('VCC', 'F.Cu', 0.5, 'R1.2', P(30, 8));
route('VCC', 'F.Cu', 0.4, P(26.5, 12.5), P(27.2, 12.5));
route('VCC', 'B.Cu', 0.4, P(27.2, 12.5), P(27.2, 19.5), P(19.525, 19.5));
route('VCC', 'B.Cu', 0.4, P(21.452, 19.5), 'C3.1');
route('VCC', 'F.Cu', 0.4, 'U1.4', P(19.525, 19.5));
route('DIS', 'F.Cu', 0.25, 'U1.7', P(28.5, 15.365), 'R2.2');
route('DIS', 'F.Cu', 0.25, 'R1.1', 'R2.2');
route('THR', 'F.Cu', 0.25, 'U1.6', P(28.5, 16.635), 'R2.1');
route('THR', 'F.Cu', 0.25, 'U1.2', P(21.4, 15.365));
route('THR', 'B.Cu', 0.25, P(21.4, 15.365), P(22.9, 16.635));
route('THR', 'F.Cu', 0.25, P(22.9, 16.635), 'U1.6');
route('THR', 'F.Cu', 0.25, 'U1.2', P(17, 15.365), P(14, 18.365), 'C1.2');
route('CTRL', 'F.Cu', 0.25, 'U1.5', P(26, 17.905), P(26, 21.05), 'C2.2');
route('OUT', 'F.Cu', 0.25, 'U1.3', P(21.4, 16.9));
route('OUT', 'B.Cu', 0.25, P(21.4, 16.9), P(21.4, 18.6), P(16.4, 18.6), P(16.4, 12.9));
route('OUT', 'F.Cu', 0.25, P(16.4, 12.9), 'R3.2');
route('LED_A', 'F.Cu', 0.25, 'R3.1', P(9.6, 12), P(8.66, 11.063), 'D1.2');
const gvias: [string, Pt][] = [['U1.1', P(19.525, 12.6)], ['C1.1', P(14, 22.6)], ['C2.1', P(30, 24.4)], ['D1.1', P(8, 14.6)]];
for (const [pad, v] of gvias) route('GND', 'F.Cu', 0.4, pad, v);
const vias = [
  ...gvias.map(([, v]) => ({ at: v, size: 0.7, drill: 0.35, net: 'GND' })),
  ...[P(27.2, 12.5), P(19.525, 19.5)].map(at => ({ at, size: 0.7, drill: 0.35, net: 'VCC' })),
  ...[P(21.4, 15.365), P(22.9, 16.635)].map(at => ({ at, size: 0.6, drill: 0.3, net: 'THR' })),
  ...[P(21.4, 16.9), P(16.4, 12.9)].map(at => ({ at, size: 0.6, drill: 0.3, net: 'OUT' })),
];

const x0 = 4, y0 = 6, x1 = 43, y1 = 26, r = 1.5;
const corners: [number, number, Pt][] = [[x0 + r, y0 + r, P(x0, y0 + r)], [x1 - r, y0 + r, P(x1 - r, y0)], [x1 - r, y1 - r, P(x1, y1 - r)], [x0 + r, y1 - r, P(x0 + r, y1)]];
const graphics: Board['graphics'] = [
  { type: 'line', a: P(x0 + r, y0), b: P(x1 - r, y0), width: 0.1, layer: 'Edge.Cuts' },
  { type: 'line', a: P(x1, y0 + r), b: P(x1, y1 - r), width: 0.1, layer: 'Edge.Cuts' },
  { type: 'line', a: P(x1 - r, y1), b: P(x0 + r, y1), width: 0.1, layer: 'Edge.Cuts' },
  { type: 'line', a: P(x0, y1 - r), b: P(x0, y0 + r), width: 0.1, layer: 'Edge.Cuts' },
  // in a Y-down frame a +90° math sweep runs clockwise on screen, which walks each corner outward
  ...corners.map(([cx, cy, s]) => ({ type: 'arc' as const, ...arcFromCenter(P(cx, cy), s, -90, false), width: 0.1, layer: 'Edge.Cuts' })),
  { type: 'text', text: '555 BLINKY', at: P(11, 24.2), size: 1.2, width: 0.18, rotation: 0, layer: 'F.SilkS' },
  { type: 'text', text: 'eda-format-converter sample', at: P(23.5, 8), size: 1, width: 0.15, rotation: 0, layer: 'B.SilkS', mirror: true },
];
const board: Board = {
  name: 'blinky-555', copperLayers: 2, footprints, tracks, vias, graphics,
  holes: [{ at: P(6.8, 8.8), d: 2.2 }, { at: P(39, 22.5), d: 2.2 }],
  zones: [{ layer: 'B.Cu', net: 'GND', outline: [P(x0 + 0.5, y0 + 0.5), P(x1 - 0.5, y0 + 0.5), P(x1 - 0.5, y1 - 0.5), P(x0 + 0.5, y1 - 0.5)], clearance: 0.3, minWidth: 0.25 }],
  nets: Object.keys(nets),
};
const kicad = writeKicadPcb(board);
writeFileSync(OUT + 'blinky-555.kicad_pcb', kicad);
const design = readFile({ name: 'blinky-555.kicad_pcb', data: kicad })[0].design;
for (const t of ['eagle', 'easyeda'] as const) for (const o of writeDesign(design, t)) writeFileSync(OUT + o.name, o.data);
console.log('board samples written');

// KiCad library sample: hand-written files in samples-src/ zipped as a .kicad_sym + .pretty bundle
import { zipSync } from 'fflate';
import { readdirSync } from 'node:fs';
const zipFiles: Record<string, Uint8Array> = { 'demo-parts.kicad_sym': readFileSync('samples-src/demo-parts.kicad_sym') };
for (const f of readdirSync('samples-src/demo-parts.pretty')) zipFiles[`demo-parts.pretty/${f}`] = readFileSync(`samples-src/demo-parts.pretty/${f}`);
writeFileSync(OUT + 'demo-parts.zip', zipSync(zipFiles, { level: 9, mtime: new Date('2026-01-01') }));
console.log('library zip written');

// ---------------------------------------------------------------- 555 blinker schematic (same nets as the board)
import type { Schematic, Sheet, Symbol as Sym, Pin as SPin, Graphic as SG } from '../src/core/model';
import { instancePins, pinOutward, netlist } from '../src/core/sch';
import { writeKicadSchematic } from '../src/core/kicad/sch';
const pin = (number: string, name: string, x: number, y: number, angle: number, length: number, type: SPin['type'] = 'passive', hidden = false): SPin => ({ number, name, at: { x, y }, angle, length, type, hidden });
const line = (x1: number, y1: number, x2: number, y2: number, w = 0.254): SG => ({ type: 'line', a: { x: x1, y: y1 }, b: { x: x2, y: y2 }, width: w, layer: 'symbol' });
const defs: Record<string, Sym> = {
  NE555: { name: 'NE555', reference: 'U', value: 'NE555', footprint: 'Package_SO:SOIC-8_3.9x4.9mm_P1.27mm', description: 'Precision timer', properties: {}, units: [{
    graphics: [{ type: 'rect', a: { x: -7.62, y: 7.62 }, b: { x: 7.62, y: -7.62 }, width: 0.254, layer: 'symbol', fill: true }],
    pins: [pin('8', 'VCC', 0, 10.16, 270, 2.54, 'power_in'), pin('1', 'GND', 0, -10.16, 90, 2.54, 'power_in'), pin('4', 'R', -10.16, 5.08, 0, 2.54, 'input'),
      pin('2', 'TR', -10.16, 0, 0, 2.54, 'input'), pin('6', 'THR', -10.16, -2.54, 0, 2.54, 'input'), pin('5', 'CV', -10.16, -5.08, 0, 2.54, 'input'),
      pin('3', 'Q', 10.16, 2.54, 180, 2.54, 'output'), pin('7', 'DIS', 10.16, -2.54, 180, 2.54, 'open_collector')] }] },
  R: { name: 'R', reference: 'R', value: 'R', properties: {}, units: [{ graphics: [{ type: 'rect', a: { x: -1.016, y: 2.54 }, b: { x: 1.016, y: -2.54 }, width: 0.254, layer: 'symbol' }],
    pins: [pin('1', '~', 0, 3.81, 270, 1.27), pin('2', '~', 0, -3.81, 90, 1.27)] }] },
  C: { name: 'C', reference: 'C', value: 'C', properties: {}, units: [{ graphics: [line(-2.032, 0.508, 2.032, 0.508, 0.508), line(-2.032, -0.508, 2.032, -0.508, 0.508)],
    pins: [pin('1', '~', 0, 3.81, 270, 3.302), pin('2', '~', 0, -3.81, 90, 3.302)] }] },
  LED: { name: 'LED', reference: 'D', value: 'LED', properties: {}, units: [{ graphics: [line(-1.27, -1.27, -1.27, 1.27), { type: 'poly', pts: [{ x: 1.27, y: -1.27 }, { x: 1.27, y: 1.27 }, { x: -1.27, y: 0 }], width: 0.254, layer: 'symbol', closed: true }, line(-0.5, 1.8, 0.6, 2.9, 0.15), line(0.4, 1.8, 1.5, 2.9, 0.15)],
    pins: [pin('1', 'K', -3.81, 0, 0, 2.54), pin('2', 'A', 3.81, 0, 180, 2.54)] }] },
  Conn_01x02: { name: 'Conn_01x02', reference: 'J', value: 'Conn_01x02', footprint: 'Connector_PinHeader_2.54mm:PinHeader_1x02_P2.54mm_Vertical', properties: {}, units: [{
    graphics: [{ type: 'rect', a: { x: -1.27, y: 1.27 }, b: { x: 1.27, y: -3.81 }, width: 0.254, layer: 'symbol', fill: true }],
    pins: [pin('1', 'Pin_1', -5.08, 0, 0, 3.81), pin('2', 'Pin_2', -5.08, -2.54, 0, 3.81)] }] },
  GND: { name: 'GND', reference: '#PWR', value: 'GND', power: true, properties: {}, units: [{ graphics: [{ type: 'poly', pts: [{ x: 0, y: 0 }, { x: 0, y: -1.27 }, { x: 1.27, y: -1.27 }, { x: 0, y: -2.54 }, { x: -1.27, y: -1.27 }, { x: 0, y: -1.27 }], width: 0.254, layer: 'symbol', closed: false }],
    pins: [pin('1', 'GND', 0, 0, 270, 0, 'power_in', true)] }] },
  VCC: { name: 'VCC', reference: '#PWR', value: 'VCC', power: true, properties: {}, units: [{ graphics: [line(0, 0, 0, 1.27), line(-0.762, 1.27, 0.762, 1.27)],
    pins: [pin('1', 'VCC', 0, 0, 90, 0, 'power_in', true)] }] },
  PWR_FLAG: { name: 'PWR_FLAG', reference: '#FLG', value: 'PWR_FLAG', power: true, properties: {}, units: [{ graphics: [line(0, 0, 0, 1.27), { type: 'poly', pts: [{ x: 0, y: 1.27 }, { x: -1.016, y: 1.905 }, { x: 0, y: 2.54 }, { x: 1.016, y: 1.905 }], width: 0.254, layer: 'symbol', closed: true }],
    pins: [pin('1', 'pwr', 0, 0, 90, 0, 'power_out')] }] },
};
const sheet: Sheet = { name: 'blinky-555', symbols: [], wires: [], buses: [], junctions: [], noConnects: [], labels: [], graphics: [] };
const sch: Schematic = { name: 'blinky-555', symbols: defs, sheets: [sheet] };
const T = (text: string, x: number, y: number) => ({ type: 'text' as const, text, at: { x, y }, size: 1.27, width: 0, rotation: 0, layer: 'symbol', justify: 'left' as const });
// reference/value label offsets (dx, dy) per symbol, so the texts sit clear of pins and wires
const LBL: Record<string, [number, number, number, number]> = { NE555: [2.54, -12.7, 2.54, 12.7], R: [2.54, -1.27, 2.54, 1.27], C: [3.3, -1.27, 3.3, 1.27], LED: [-1.27, -3.81, -1.27, 3.81], Conn_01x02: [-1.27, -2.54, -1.27, 5.08] };
const place = (ref: string, lib: string, value: string, x: number, y: number, rotation = 0) => {
  const fp = parts.find(p => p[0] === ref)?.[2];
  const [rx, ry, vx, vy] = rotation ? [-1.27, -3.3, -1.27, 3.3] : LBL[lib];
  const inst = { ref, value, lib, unit: 1, at: { x, y }, rotation, properties: {}, footprint: fp ? fp.replace('.pretty/', ':') : defs[lib].footprint, refText: T(ref, x + rx, y + ry), valueText: T(value, x + vx, y + vy) };
  sheet.symbols.push(inst);
  return inst;
};
const placed = [
  place('U1', 'NE555', 'NE555', 127, 88.9), place('R1', 'R', '10k', 157.48, 76.2), place('R2', 'R', '47k', 157.48, 96.52), place('R3', 'R', '470', 172.72, 76.2, 90),
  place('C1', 'C', '10uF', 101.6, 109.22), place('C2', 'C', '10nF', 116.84, 114.3), place('C3', 'C', '100nF', 88.9, 76.2), place('D1', 'LED', 'red', 195.58, 76.2), place('J1', 'Conn_01x02', 'PWR', 76.2, 96.52),
];
// every pin gets a short wire to a label of its net; supply pins end in a power symbol
let pwrN = 0;
for (const inst of placed) for (const { pin: p, at } of instancePins(sch, inst)) {
  const net = netOf(inst.ref, p.number)!;
  const a = pinOutward(inst, p) * Math.PI / 180;
  const end = { x: +(at.x + Math.cos(a) * 2.54).toFixed(2), y: +(at.y - Math.sin(a) * 2.54).toFixed(2) };
  sheet.wires.push({ a: at, b: end });
  if (net === 'VCC' || net === 'GND') {
    const pw = { ref: `#PWR0${++pwrN}`, value: net, lib: net, unit: 1, at: end, rotation: net === 'GND' ? (Math.abs(end.y - at.y) > 1 && end.y < at.y ? 180 : 0) : (end.y > at.y ? 180 : 0), properties: {} };
    sheet.symbols.push(pw);
  } else sheet.labels.push({ text: net, at: end, rotation: Math.round(a * 180 / Math.PI / 90) * 90 % 360, kind: 'local' });
}
// KiCad's ERC wants the supply nets marked as driven
let flg = 0;
for (const pw of sheet.symbols.filter(x => x.lib === 'VCC' || x.lib === 'GND').slice(0, 99)) {
  if (flg >= 2 || !placed.find(x => x.ref === 'J1')) break;
  const j1 = instancePins(sch, placed.find(x => x.ref === 'J1')!);
  const wireEnds = j1.map(p => sheet.wires.find(w => w.a.x === p.at.x && w.a.y === p.at.y)?.b);
  if (!wireEnds.some(e => e && e.x === pw.at.x && e.y === pw.at.y)) continue;
  sheet.symbols.push({ ref: `#FLG0${++flg}`, value: 'PWR_FLAG', lib: 'PWR_FLAG', unit: 1, at: pw.at, rotation: pw.lib === 'GND' ? 180 : 0, properties: {} });
}
sheet.graphics.push({ type: 'text', text: '555 astable LED blinker — eda-format-converter sample', at: { x: 76.2, y: 60.96 }, size: 2, width: 0, rotation: 0, layer: 'Notes', justify: 'left' });
// the schematic must have exactly the nets of the board
const schNets = netlist(sch).nets.filter(n => n.pins.length > 1).map(n => n.pins.join(' ')).sort();
const brdNets = Object.values(nets).map(v => v.slice().sort().join(' ')).sort();
if (JSON.stringify(schNets) !== JSON.stringify(brdNets)) throw new Error(`schematic nets differ from board nets:\n${schNets.join('\n')}\n--\n${brdNets.join('\n')}`);
for (const o of writeKicadSchematic(sch)) writeFileSync(OUT + o.name, o.data);
const schDesign = { kind: 'schematic' as const, name: 'blinky-555', schematic: sch };
for (const t of ['eagle', 'easyeda'] as const) for (const o of writeDesign(schDesign, t)) writeFileSync(OUT + o.name, o.data);
console.log('schematic samples written');

// ---------------------------------------------------------------- whole projects: schematic + board in one zip
const project = (zipName: string, files: string[]) => {
  const z: Record<string, Uint8Array> = {};
  for (const f of files) z[f.replace(/^.*\//, '')] = readFileSync(OUT + f);
  writeFileSync(OUT + zipName, zipSync(z, { level: 9, mtime: new Date('2026-01-01') }));
};
project('blinky-555-kicad.zip', ['blinky-555.kicad_sch', 'blinky-555.kicad_pcb']);
project('blinky-555-eagle.zip', ['blinky-555.sch', 'blinky-555.brd']);
project('blinky-555-easyeda.zip', ['blinky-555.schematic.json', 'blinky-555.json']);
project('usb-power-adapter-altium.zip', ['usb-power-adapter.SchDoc', 'usb-power-adapter.PcbDoc']);
console.log('project zips written');
