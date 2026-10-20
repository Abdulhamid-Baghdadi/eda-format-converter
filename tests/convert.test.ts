import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { readFile, writeDesign, convert, UnsupportedError, type Target } from '../src/core/index';
import type { Board, Design, Library } from '../src/core/model';
import { boardDiff } from './boardDiff';
import { footprintDiff, symbolDiff } from './libDiff';

const S = (f: string) => ({ name: f, data: new Uint8Array(readFileSync(`public/samples/${f}`)) });
const one = (f: string) => readFile(S(f));
const board = (f: string): Board => { const d = one(f)[0].design; if (d.kind !== 'board') throw new Error(); return d.board; };
const lib = (f: string): Library => {
  const ds = one(f).map(r => r.design);
  return { symbols: ds.flatMap(d => (d.kind === 'library' ? d.library.symbols : [])), footprints: ds.flatMap(d => (d.kind === 'library' ? d.library.footprints : [])) };
};
const TARGETS: Target[] = ['kicad', 'eagle', 'easyeda'];
const back = (d: Design, t: Target) => writeDesign(d, t).flatMap(o => readFile({ name: o.name, data: o.data }).map(r => r.design));

describe('format detection', () => {
  it.each([
    ['blinky-555.kicad_pcb', 'kicad', 'board'], ['blinky-555.brd', 'eagle', 'board'], ['blinky-555.json', 'easyeda', 'board'],
    ['demo-parts.lbr', 'eagle', 'library'], ['SOT-23-5_regulator.json', 'easyeda', 'library'], ['demo-parts.zip', 'kicad', 'library'],
  ])('%s is %s %s', (f, fmt, kind) => {
    const r = one(f);
    expect(r[0].format).toBe(fmt);
    expect(r[0].design.kind).toBe(kind);
  });
  it('explains unsupported inputs', () => {
    expect(() => readFile({ name: 'x.kicad_sch', data: '(kicad_sch (version 1))' })).toThrow(/schematics/);
    expect(() => readFile({ name: 'x.sch', data: '<?xml version="1.0"?><eagle><drawing><schematic/></drawing></eagle>' })).toThrow(UnsupportedError);
    expect(() => readFile({ name: 'x.txt', data: 'hello' })).toThrow(/recognise/);
  });
});

describe('sample contents', () => {
  it('reads the demo board in every format with identical copper', () => {
    const k = board('blinky-555.kicad_pcb');
    expect(k.footprints).toHaveLength(9);
    expect(k.vias).toHaveLength(10);
    expect(k.zones).toHaveLength(1);
    expect(k.footprints.find(f => f.ref === 'C3')!.side).toBe('bottom');
    for (const f of ['blinky-555.brd', 'blinky-555.json']) expect(boardDiff(k, board(f)).problems).toEqual([]);
  });
  it('reads the Eagle library: devices, gates and pin-to-pad connects', () => {
    const l = lib('demo-parts.lbr');
    expect(l.footprints.map(f => f.name)).toEqual(['R0805', 'SOT23-5', 'SO8', 'TO92', '1X03']);
    const lm = l.symbols.find(s => s.name === 'LM358D')!;
    expect(lm.units).toHaveLength(3);
    expect(lm.footprint).toBe('demo-parts:SO8');
    expect(lm.units[0].pins.map(p => `${p.name}=${p.number}`).sort()).toEqual(['+IN=3', '-IN=2', 'OUT=1']);
    expect(l.symbols.find(s => s.name === 'GND')!.power).toBe(true);
    const so8 = l.footprints.find(f => f.name === 'SO8')!;
    expect(so8.pads.find(p => p.number === '1')!.at).toEqual({ x: -1.905, y: 2.7 }); // Eagle is Y-up, the model is Y-down
    expect(l.footprints.find(f => f.name === '1X03')!.pads.filter(p => p.kind === 'thru').map(p => p.shape)).toEqual(['rect', 'circle', 'octagon']);
  });
  it('reads the EasyEDA component: footprint in mm, pins with direction and type', () => {
    const l = lib('SOT-23-5_regulator.json');
    const fp = l.footprints[0];
    expect(fp.name).toBe('SOT-23-5_demo');
    const p1 = fp.pads.find(p => p.number === '1')!;
    expect(p1.at.x).toBeCloseTo(-0.95, 3); expect(p1.at.y).toBeCloseTo(1.3, 3);
    expect(p1.w).toBeCloseTo(0.6, 3); expect(p1.h).toBeCloseTo(1.1, 3);
    expect(fp.model3d?.[0].path).toContain('SOT-23-5_demo');
    const s = l.symbols[0];
    expect(s.footprint).toBe('SOT-23-5_demo');
    const gnd = s.units[0].pins.find(p => p.name === 'GND')!;
    expect(gnd.angle).toBe(90); // body is above the connection point
    expect(gnd.type).toBe('power_in');
    expect(s.units[0].pins.find(p => p.name === 'NC')!.shape).toBe('inverted');
  });
  it('reads a zipped KiCad library (.kicad_sym + .pretty)', () => {
    const l = lib('demo-parts.zip');
    expect(l.symbols.map(s => s.name)).toEqual(['OpAmp_Dual_Demo', 'LED_Demo']);
    expect(l.symbols[0].units).toHaveLength(3);
    expect(l.symbols[1].units[0].graphics.length).toBeGreaterThan(3); // common (unit 0) graphics are merged in
    const t = l.footprints.find(f => f.name === 'Terminal_2P_Demo')!;
    expect(t.pads.find(p => p.number === '2')!.drill).toEqual({ w: 1.3, h: 1.8 });
  });
});

describe('round trips through every format', () => {
  for (const f of ['blinky-555.kicad_pcb', 'blinky-555.brd', 'blinky-555.json']) {
    for (const t of TARGETS) {
      it(`${f} -> ${t}`, () => {
        const src = one(f)[0].design as Extract<Design, { kind: 'board' }>;
        const out = back(src, t)[0] as Extract<Design, { kind: 'board' }>;
        expect(boardDiff(src.board, out.board).problems).toEqual([]);
        expect(out.board.zones.length).toBe(src.board.zones.length);
        expect(out.board.graphics.filter(g => g.layer === 'Edge.Cuts').length).toBe(src.board.graphics.filter(g => g.layer === 'Edge.Cuts').length);
      });
    }
  }
  for (const f of ['demo-parts.lbr', 'SOT-23-5_regulator.json', 'demo-parts.zip']) {
    for (const t of TARGETS) {
      it(`${f} -> ${t}`, () => {
        for (const r of one(f)) {
          if (r.design.kind !== 'library') continue;
          const src = r.design.library;
          const out = back(r.design, t);
          const fps = out.flatMap(d => (d.kind === 'library' ? d.library.footprints : []));
          const syms = out.flatMap(d => (d.kind === 'library' ? d.library.symbols : []));
          // Eagle cannot hold every through-hole pad shape: sizes are checked where the format can express them
          src.footprints.forEach((fp, i) => expect(footprintDiff(fp, fps[i], { sizes: t !== 'eagle' || !fp.pads.some(p => p.kind === 'thru' && p.shape !== 'circle' && p.shape !== 'octagon') })).toEqual([]));
          if (t === 'easyeda') {
            // one EasyEDA symbol per unit
            let k = 0;
            for (const s of src.symbols) { const merged = { ...s, units: syms.slice(k, k + s.units.length).flatMap(x => x.units) }; k += s.units.length; expect(symbolDiff(s, merged)).toEqual([]); }
          } else src.symbols.forEach((s, i) => expect(symbolDiff(s, syms[i])).toEqual([]));
        }
      });
    }
  }
});

describe('reports', () => {
  it('lists approximations instead of silently changing geometry', () => {
    const [res] = convert(S('demo-parts.zip'), 'eagle').filter(r => r.input.design.kind === 'library' && r.input.design.library.footprints.length);
    const kinds = res.writeReport.list().filter(e => e.severity !== 'converted').map(e => e.kind);
    expect(kinds).toEqual(expect.arrayContaining(['rectangular THT pad', 'oval THT pad', 'slotted hole', '3D model']));
  });
  it('counts converted items', () => {
    const [res] = convert(S('blinky-555.brd'), 'kicad');
    expect(res.writeReport.total('converted')).toBeGreaterThan(50);
    expect(res.input.report.list().find(e => e.kind === 'footprint')?.count).toBe(9);
  });
});
