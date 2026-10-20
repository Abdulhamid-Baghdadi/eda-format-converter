import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { readFile, writeDesign, type Target } from '../src/core/index';
import { readCfb } from '../src/core/altium/cfb';
import { dim, layerIdFromName } from '../src/core/altium/pcb';
import type { Design } from '../src/core/model';
import { boardDiff } from './boardDiff';
import { footprintDiff, symbolDiff } from './libDiff';

const S = (f: string) => ({ name: f, data: new Uint8Array(readFileSync(`public/samples/${f}`)) });
const design = (f: string) => readFile(S(f))[0].design;
const back = (d: Design, t: Target) => writeDesign(d, t).flatMap(o => readFile({ name: o.name, data: o.data }).map(r => r.design));

describe('Altium containers', () => {
  it('lists the streams of an OLE compound file', () => {
    const s = readCfb(S('usb-power-adapter.PcbDoc').data);
    expect(s.has('Board6/Data')).toBe(true);
    expect(s.has('Pads6/Data')).toBe(true);
    expect(s.get('Nets6/Data')!.length).toBeGreaterThan(0);
  });
  it('parses units and layer names', () => {
    expect(dim('100mil')).toBeCloseTo(2.54, 9);
    expect(dim('2.5mm')).toBe(2.5);
    expect(layerIdFromName('MID2')).toBe(3);
    expect(layerIdFromName('MECHANICAL1')).toBe(57);
  });
});

describe('Altium PcbDoc', () => {
  const d = design('usb-power-adapter.PcbDoc');
  it('reads components, pads, nets, tracks, vias and the outline', () => {
    expect(d.kind).toBe('board');
    if (d.kind !== 'board') return;
    const b = d.board;
    expect(b.footprints).toHaveLength(7);
    expect(b.footprints.reduce((n, f) => n + f.footprint.pads.length, 0)).toBe(46);
    expect(b.tracks).toHaveLength(12);
    expect(b.vias).toHaveLength(4);
    expect(b.graphics.filter(g => g.layer === 'Edge.Cuts').length).toBeGreaterThan(3);
    expect(b.footprints.every(f => f.ref)).toBe(true);
    expect(b.footprints.flatMap(f => f.footprint.pads).filter(p => p.net).length).toBe(24);
  });
  for (const t of ['kicad', 'eagle', 'easyeda'] as Target[]) {
    it(`converts to ${t} without moving any copper`, () => {
      if (d.kind !== 'board') return;
      const out = back(d, t)[0];
      if (out.kind !== 'board') throw new Error();
      expect(boardDiff(d.board, out.board, { checkSizes: t !== 'eagle' }).problems).toEqual([]);
    });
  }
});

describe('Altium PcbLib', () => {
  const d = design('QFN-24_4x4.PcbLib');
  it('reads footprints in millimetres with Y flipped to the model', () => {
    if (d.kind !== 'library') throw new Error();
    const fp = d.library.footprints[0];
    expect(fp.name).toBe('PSEMI QFN-24 4x4');
    const p1 = fp.pads.find(p => p.number === '1')!;
    expect(p1.at.x).toBeCloseTo(-1.9, 3); expect(p1.at.y).toBeCloseTo(-1.25, 3);
    expect(p1.w).toBeCloseTo(0.3, 3); expect(p1.h).toBeCloseTo(0.6, 3);
    expect(fp.pads.filter(p => p.number).length).toBe(25);
  });
  for (const t of ['kicad', 'eagle', 'easyeda'] as Target[]) {
    it(`converts to ${t}`, () => {
      if (d.kind !== 'library') throw new Error();
      const fps = back(d, t).flatMap(x => (x.kind === 'library' ? x.library.footprints : []));
      expect(footprintDiff(d.library.footprints[0], fps[0])).toEqual([]);
    });
  }
});

describe('Altium SchLib', () => {
  const d = design('CM4.SchLib');
  it('reads multi-part symbols with binary pins', () => {
    if (d.kind !== 'library') throw new Error();
    const cm4 = d.library.symbols.find(s => s.name === 'CM4')!;
    expect(cm4.units).toHaveLength(21);
    expect(cm4.units.flatMap(u => u.pins).length).toBeGreaterThan(150);
    const pin = cm4.units[0].pins[0];
    expect([0, 90, 180, 270]).toContain(pin.angle);
  });
  for (const t of ['kicad', 'easyeda'] as Target[]) {
    it(`converts to ${t} with every pin in place`, () => {
      if (d.kind !== 'library') throw new Error();
      const syms = back(d, t).flatMap(x => (x.kind === 'library' ? x.library.symbols : []));
      let k = 0;
      for (const s of d.library.symbols) {
        const got = t === 'easyeda' ? { ...s, units: syms.slice(k, k + s.units.length).flatMap(x => x.units) } : syms[k];
        k += t === 'easyeda' ? s.units.length : 1;
        expect(symbolDiff(s, got)).toEqual([]);
      }
    });
  }
});
