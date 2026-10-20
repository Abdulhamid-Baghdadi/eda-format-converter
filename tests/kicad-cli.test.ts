/**
 * Opens converted files in the real KiCad (kicad-cli) when it is installed: symbol/footprint libraries must load and
 * plot, converted boards must pass DRC after refilling zones, and KiCad's own Eagle importer must agree with our
 * Eagle reader. Skipped automatically when KiCad is not available (e.g. on CI).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { convert, readFile } from '../src/core/index';
import { readKicadPcb, placeDown } from '../src/core/kicad/read';
import { boardDiff } from './boardDiff';
import { netlist, netlistDiff, type Netlist } from '../src/core/sch';

function kicadNetlist(file: string): Netlist {
  const x = file + '.net.xml';
  run(['sch', 'export', 'netlist', '--format', 'kicadxml', '-o', x, file]);
  const src = readFileSync(x, 'utf8');
  const nets: Netlist['nets'] = [];
  for (const m of src.matchAll(/<net code="\d+" name="([^"]*)"[^>]*>([\s\S]*?)<\/net>/g)) {
    const pins = [...m[2].matchAll(/<node ref="([^"]+)" pin="([^"]+)"/g)].filter(n => !n[1].startsWith('#')).map(n => `${n[1]}.${n[2]}`).sort();
    if (pins.length) nets.push({ name: m[1], pins });
  }
  return { nets };
}

const CANDIDATES = [process.env.KICAD_CLI, 'C:/Program Files/KiCad/10.0/bin/kicad-cli.exe', 'C:/Program Files/KiCad/9.0/bin/kicad-cli.exe', '/usr/bin/kicad-cli', '/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli'];
const CLI = CANDIDATES.find(p => p && existsSync(p));
const run = (args: string[]) => execFileSync(CLI!, args, { stdio: 'pipe', timeout: 120_000 }).toString();
let dir = '';
const write = (sub: string, files: { name: string; data: string | Uint8Array }[]) => files.map(f => { const p = join(dir, sub, f.name); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, f.data); return p; });
const sample = (f: string) => ({ name: f, data: new Uint8Array(readFileSync(`public/samples/${f}`)) });

describe.skipIf(!CLI)('KiCad opens what we write', () => {
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'edaconv-')); });

  for (const f of ['blinky-555.kicad_pcb', 'blinky-555.brd', 'blinky-555.json']) {
    it(`${f} -> .kicad_pcb passes DRC`, () => {
      const [res] = convert(sample(f), 'kicad');
      const [pcb] = write(f, res.outputs);
      const report = join(dir, f + '.drc.json');
      run(['pcb', 'drc', '--refill-zones', '--format', 'json', '-o', report, pcb]);
      const drc = JSON.parse(readFileSync(report, 'utf8'));
      expect(drc.violations.map((v: { type: string }) => v.type)).toEqual([]);
      expect(drc.unconnected_items).toEqual([]);
    }, 120_000);
  }

  it("KiCad's Eagle importer agrees with our Eagle reader and writer", () => {
    const [res] = convert(sample('blinky-555.kicad_pcb'), 'eagle');
    const [brd] = write('eagle', res.outputs);
    const out = join(dir, 'imported.kicad_pcb');
    run(['pcb', 'import', '--format', 'eagle', '-o', out, brd]);
    const ours = readFile({ name: 'x.brd', data: readFileSync(brd) })[0].design;
    if (ours.kind !== 'board') throw new Error();
    expect(boardDiff(ours.board, readKicadPcb(readFileSync(out, 'utf8')), { checkSizes: false }).problems).toEqual([]);
  }, 120_000);

  it("KiCad's Altium importer agrees with our Altium reader", () => {
    const src = join('public', 'samples', 'usb-power-adapter.PcbDoc');
    const out = join(dir, 'altium-import.kicad_pcb');
    run(['pcb', 'import', '--format', 'altium', '-o', out, src]);
    const ours = readFile(sample('usb-power-adapter.PcbDoc'))[0].design;
    if (ours.kind !== 'board') throw new Error();
    const theirs = readKicadPcb(readFileSync(out, 'utf8'));
    // KiCad moves the design onto its sheet: find the shift from pads matched by reference and number
    const world = (b: typeof theirs) => new Map(b.footprints.flatMap(f => f.footprint.pads.map(p => [`${f.ref}.${p.number}`, placeDown(f, p.at)] as const)));
    const wa = world(ours.board), wb = world(theirs);
    const ds = [...wa].filter(([k]) => wb.has(k)).map(([k, v]) => ({ x: wb.get(k)!.x - v.x, y: wb.get(k)!.y - v.y }));
    expect(ds.length).toBeGreaterThan(10);
    const med = (xs: number[]) => xs.sort((p, q) => p - q)[xs.length >> 1];
    const d = { x: med(ds.map(v => v.x)), y: med(ds.map(v => v.y)) };
    const sh = (p: { x: number; y: number }) => ({ x: p.x + d.x, y: p.y + d.y });
    const moved = { ...ours.board, footprints: ours.board.footprints.map(f => ({ ...f, at: sh(f.at) })), tracks: ours.board.tracks.map(t => ({ ...t, a: sh(t.a), b: sh(t.b), mid: t.mid && sh(t.mid) })), vias: ours.board.vias.map(v => ({ ...v, at: sh(v.at) })), holes: ours.board.holes.map(h => ({ ...h, at: sh(h.at) })) };
    expect(boardDiff(moved, theirs, { tol: 0.005 }).problems).toEqual([]);
  }, 120_000);

  it("KiCad's netlist of the KiCad sample equals ours", () => {
    const d = readFile(sample('blinky-555.kicad_sch'))[0].design;
    if (d.kind !== 'schematic') throw new Error();
    expect(netlistDiff(netlist(d.schematic), kicadNetlist(join('public', 'samples', 'blinky-555.kicad_sch')))).toEqual([]);
  }, 120_000);

  for (const f of ['blinky-555.kicad_sch', 'blinky-555.sch', 'blinky-555.schematic.json', 'usb-power-adapter.SchDoc']) {
    it(`${f} -> .kicad_sch: KiCad reads the same connections${f.endsWith('.json') || f.endsWith('.SchDoc') ? '' : ' and ERC has no errors'}`, () => {
      const [res] = convert(sample(f), 'kicad');
      const [root] = write('sch-' + f, res.outputs);
      if (res.input.design.kind !== 'schematic') throw new Error();
      expect(netlistDiff(netlist(res.input.design.schematic), kicadNetlist(root))).toEqual([]);
      if (f.endsWith('.json') || f.endsWith('.SchDoc')) return; // no PWR_FLAG in EasyEDA/Altium sources: ERC flags undriven supplies
      const rep = join(dir, f + '.erc.json');
      run(['sch', 'erc', '--format', 'json', '--severity-error', '-o', rep, root]);
      const erc = JSON.parse(readFileSync(rep, 'utf8'));
      expect(erc.sheets.flatMap((x: { violations: { description: string }[] }) => x.violations.map(v => v.description))).toEqual([]);
    }, 120_000);
  }

  for (const f of ['demo-parts.lbr', 'SOT-23-5_regulator.json', 'demo-parts.zip', 'QFN-24_4x4.PcbLib', 'CM4.SchLib']) {
    it(`${f} -> KiCad libraries load and plot`, () => {
      for (const res of convert(sample(f), 'kicad')) {
        const paths = write(f, res.outputs);
        for (const p of paths.filter(x => x.endsWith('.kicad_sym'))) {
          const o = join(dir, f, 'sym-svg'); mkdirSync(o, { recursive: true });
          run(['sym', 'export', 'svg', '-o', o, p]);
          expect(readdirSync(o).length).toBeGreaterThan(0);
        }
        const pretty = [...new Set(paths.filter(x => x.endsWith('.kicad_mod')).map(x => dirname(x)))];
        for (const p of pretty) {
          const o = join(dir, f, 'fp-svg'); mkdirSync(o, { recursive: true });
          run(['fp', 'export', 'svg', '-o', o, p]);
          expect(readdirSync(o).length).toBeGreaterThan(0);
        }
      }
    }, 120_000);
  }
});
