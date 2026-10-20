import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { zipSync, strToU8 } from 'fflate';
import { readFile, writeDesign, type Target } from '../src/core/index';
import { netlist, netlistDiff, placeSym, unplaceSym, type Netlist } from '../src/core/sch';
import type { Design, Schematic } from '../src/core/model';

const S = (f: string) => ({ name: f, data: new Uint8Array(readFileSync(`public/samples/${f}`)) });
const sch = (f: string): Schematic => { const d = readFile(S(f))[0].design; if (d.kind !== 'schematic') throw new Error(`${f} is ${d.kind}`); return d.schematic; };
/** Write in a format and read the result back (several files are zipped, as a user would drop them). */
function back(s: Schematic, t: Target): Schematic {
  const outs = writeDesign({ kind: 'schematic', name: s.name, schematic: s } as Design, t);
  const data = outs.length > 1 ? zipSync(Object.fromEntries(outs.map(o => [o.name, typeof o.data === 'string' ? strToU8(o.data) : o.data]))) : outs[0].data;
  const ds = readFile({ name: outs.length > 1 ? 'x.zip' : outs[0].name, data }).map(r => r.design).filter((d): d is Extract<Design, { kind: 'schematic' }> => d.kind === 'schematic');
  return { name: s.name, symbols: Object.assign({}, ...ds.map(d => d.schematic.symbols)), sheets: ds.flatMap(d => d.schematic.sheets) };
}
const boardNets = (f: string): Netlist => {
  const d = readFile(S(f))[0].design;
  if (d.kind !== 'board') throw new Error();
  const m = new Map<string, string[]>();
  for (const fp of d.board.footprints) for (const p of fp.footprint.pads) if (p.net && p.number) m.set(p.net, [...(m.get(p.net) ?? []), `${fp.ref}.${p.number}`]);
  return { nets: [...m].map(([name, pins]) => ({ name, pins: pins.sort() })) };
};

describe('schematic samples', () => {
  it.each(['blinky-555.kicad_sch', 'blinky-555.sch', 'blinky-555.schematic.json', 'usb-power-adapter.SchDoc'])('%s is detected as a schematic', f => {
    expect(sch(f).sheets.length).toBe(1);
  });
  it.each(['blinky-555.kicad_sch', 'blinky-555.sch', 'blinky-555.schematic.json'])('%s has exactly the nets of the 555 board', f => {
    expect(netlistDiff(netlist(sch(f)), boardNets('blinky-555.kicad_pcb'))).toEqual([]);
    const named = netlist(sch(f)).nets.map(n => n.name);
    expect(named).toEqual(expect.arrayContaining(['VCC', 'GND', 'THR', 'DIS', 'OUT']));
  });
  it('the Altium schematic matches its Altium board', () => {
    const board = boardNets('usb-power-adapter.PcbDoc');
    const refs = new Set(board.nets.flatMap(n => n.pins.map(p => p.split('.')[0])));
    for (const n of netlist(sch('usb-power-adapter.SchDoc')).nets) {
      const pins = n.pins.filter(p => refs.has(p.split('.')[0]));
      if (pins.length < 2) continue;
      const on = new Set(pins.map(p => board.nets.find(b => b.pins.includes(p))?.name));
      expect([...on]).toHaveLength(1);
    }
  });
});

describe('schematic round trips keep every connection', () => {
  for (const f of ['blinky-555.kicad_sch', 'blinky-555.sch', 'blinky-555.schematic.json', 'usb-power-adapter.SchDoc']) {
    for (const t of ['kicad', 'eagle', 'easyeda'] as Target[]) {
      it(`${f} -> ${t}`, () => {
        const a = sch(f);
        expect(netlistDiff(netlist(a), netlist(back(a, t)))).toEqual([]);
      });
    }
  }
});

describe('placement and connectivity rules', () => {
  it('placeSym and unplaceSym are inverses for every rotation and mirror', () => {
    for (const rotation of [0, 90, 180, 270]) for (const mirror of [undefined, 'x', 'y'] as const) {
      const inst = { at: { x: 10, y: 20 }, rotation, mirror };
      const p = { x: 2.54, y: -5.08 };
      const q = unplaceSym(inst, placeSym(inst, p));
      expect(q.x).toBeCloseTo(p.x, 6); expect(q.y).toBeCloseTo(p.y, 6);
    }
  });
  it('rotates first, then mirrors (KiCad order)', () => {
    // pin at (1,0) in the symbol, rotated 90° then mirrored left/right: (1,0) -> (0,-1) on screen -> (0,-1)
    expect(placeSym({ at: { x: 0, y: 0 }, rotation: 90, mirror: 'y' }, { x: 1, y: 0 })).toEqual({ x: 0, y: -1 });
    expect(placeSym({ at: { x: 0, y: 0 }, rotation: 90, mirror: 'x' }, { x: 1, y: 0 })).toEqual({ x: 0, y: 1 });
  });
  it('hidden power pins join the global net of their name; PWR_FLAG names nothing', () => {
    const s = sch('blinky-555.kicad_sch');
    const n = netlist(s);
    expect(n.nets.find(x => x.name === 'PWR_FLAG')).toBeUndefined();
    expect(n.nets.find(x => x.name === 'GND')!.pins).toContain('U1.1');
  });
});
