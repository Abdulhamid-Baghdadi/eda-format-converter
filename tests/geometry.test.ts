import { describe, it, expect } from 'vitest';
import { arcSweep, svgArcMid, arcFromCenter, mirrorFootprintX } from '../src/core/geom';
import { curveArc, parseRot, readEagleBoard } from '../src/core/eagle/read';
import { parsePath } from '../src/core/easyeda/read';
import { parseSExpr, writeSExpr, q } from '../src/core/kicad/sexpr';
import { placeDown } from '../src/core/kicad/read';

const close = (a: { x: number; y: number }, b: { x: number; y: number }) => { expect(a.x).toBeCloseTo(b.x, 6); expect(a.y).toBeCloseTo(b.y, 6); };

describe('s-expressions', () => {
  it('parses quoted strings, numbers and escapes', () => {
    const [e] = parseSExpr('(pad "1" smd rect (at -1.5 2e-1 90) (net 3 "a \\"b\\""))') as unknown[][];
    expect(String(e[1])).toBe('1');
    expect(e[4]).toEqual(['at', -1.5, 0.2, 90]);
    expect(String((e[5] as unknown[])[2])).toBe('a "b"');
  });
  it('round-trips through the writer', () => {
    const src = writeSExpr(['footprint', q('X'), ['layer', q('F.Cu')], ['pad', q('1'), 'smd', 'rect', ['at', 0, -0]]]);
    expect(src).toBe('(footprint "X" (layer "F.Cu") (pad "1" smd rect (at 0 0)))');
  });
});

describe('arcs', () => {
  it('Eagle curve: +90° from (1,0) to (0,1) is a CCW quarter circle around the origin', () => {
    const a = curveArc({ x: 1, y: 0 }, { x: 0, y: 1 }, 90);
    close(a.mid, { x: Math.SQRT1_2, y: Math.SQRT1_2 });
    expect(arcSweep(a.start, a.mid, a.end)!.sweep).toBeCloseTo(90, 6);
  });
  it('SVG arcs: sweep flag 1 runs clockwise on a Y-down screen', () => {
    // from (1,0) to (-1,0) around the origin; clockwise on screen passes through (0,1) (below)
    close(svgArcMid({ x: 1, y: 0 }, { x: -1, y: 0 }, 1, false, true), { x: 0, y: 1 });
    close(svgArcMid({ x: 1, y: 0 }, { x: -1, y: 0 }, 1, false, false), { x: 0, y: -1 });
    // large-arc flag picks the long way round
    const m = svgArcMid({ x: 1, y: 0 }, { x: 0, y: 1 }, 1, true, false);
    close(m, { x: -Math.SQRT1_2, y: -Math.SQRT1_2 });
  });
  it('EasyEDA paths keep arc mid points', () => {
    const p = parsePath('M 10 0 A 10 10 0 0 1 -10 0');
    expect(p.arcs).toHaveLength(1);
    close(p.arcs[0].mid, { x: 0, y: 10 });
  });
  it('arcFromCenter / arcSweep agree', () => {
    const a = arcFromCenter({ x: 0, y: 0 }, { x: 2, y: 0 }, 270, true);
    expect(arcSweep(a.start, a.mid, a.end)!.sweep).toBeCloseTo(270, 6);
  });
});

describe('Eagle placement', () => {
  it('parses rotation strings', () => {
    expect(parseRot('MR90')).toEqual({ spin: false, mirror: true, angle: 90 });
    expect(parseRot('SR45')).toEqual({ spin: true, mirror: false, angle: 45 });
  });
  it('MRθ rotates first and then mirrors (matches KiCad’s own Eagle importer)', () => {
    const brd = `<?xml version="1.0"?><eagle version="9.6.2"><drawing><board><plain/><libraries><library name="l"><packages><package name="P">
      <smd name="1" x="1" y="0" dx="0.5" dy="0.5" layer="1"/></package></packages></library></libraries>
      <elements><element name="U1" library="l" package="P" value="" x="10" y="10" rot="MR90"/></elements><signals/></board></drawing></eagle>`;
    const b = readEagleBoard(brd);
    const f = b.footprints[0];
    expect(f.side).toBe('bottom');
    // rotate (1,0) by 90° -> (0,1), mirror about Y -> (0,1); in Y-down board coordinates that is (10, -11)
    close(placeDown(f, f.footprint.pads[0].at), { x: 10, y: -11 });
    expect(f.footprint.pads[0].side).toBe('B');
  });
  it('mirroring a footprint twice is the identity', () => {
    const fp = { name: 'x', graphics: [], pads: [{ number: '1', kind: 'smd' as const, shape: 'rect' as const, at: { x: 1, y: 2 }, rotation: 30, w: 1, h: 2, side: 'F' as const }] };
    expect(mirrorFootprintX(mirrorFootprintX(fp)).pads[0]).toEqual(fp.pads[0]);
  });
});
