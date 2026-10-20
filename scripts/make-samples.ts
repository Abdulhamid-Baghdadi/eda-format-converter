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
