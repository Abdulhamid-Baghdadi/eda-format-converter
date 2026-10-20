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
import { readKicadPcb } from '../src/core/kicad/read';
import { boardDiff } from './boardDiff';

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

  for (const f of ['demo-parts.lbr', 'SOT-23-5_regulator.json', 'demo-parts.zip']) {
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
