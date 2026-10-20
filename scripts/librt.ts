// Verification helper (local): round-trips KiCad library files through every format and diffs them.
// node dist/librt.mjs <outdir> <.pretty dirs | .kicad_sym | .lbr | EasyEDA .json ...>
import { readFileSync, writeFileSync, mkdirSync, statSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { readFile, writeDesign, type Format } from '../src/core/index';
import { footprintDiff, symbolDiff } from '../tests/libDiff';
const [out, ...args] = process.argv.slice(2);
const files = args.flatMap(a => statSync(a).isDirectory() ? readdirSync(a).filter(f => /\.(kicad_mod|kicad_sym|lbr|json|pcblib|schlib)$/i.test(f)).map(f => join(a, f)) : [a]);
mkdirSync(out, { recursive: true });
const totals: Record<string, { items: number; problems: number; samples: string[] }> = {};
for (const file of files) {
  let src;
  try { src = readFile({ name: basename(file), data: new Uint8Array(readFileSync(file)) }); } catch (e) { console.log('READ FAIL', file, (e as Error).message); continue; }
  for (const s of src) {
    if (s.design.kind !== 'library') continue;
    const lib = s.design.library;
    for (const t of ['kicad', 'eagle', 'easyeda'] as Format[]) {
      const tot = (totals[`${s.format}->${t}`] ??= { items: 0, problems: 0, samples: [] });
      try {
        const outs = writeDesign(s.design, t);
        for (const o of outs) { const p = join(out, t, o.name); mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, o.data); }
        const back = outs.flatMap(o => readFile({ name: o.name, data: o.data as string }));
        const fps = back.flatMap(r => r.design.kind === 'library' ? r.design.library.footprints : []);
        const syms = back.flatMap(r => r.design.kind === 'library' ? r.design.library.symbols : []);
        lib.footprints.forEach((fp, i) => { tot.items++; const d = footprintDiff(fp, fps[i] ?? { name: '?', pads: [], graphics: [] }); if (d.length) { tot.problems++; if (tot.samples.length < 8) tot.samples.push(...d.slice(0, 2)); } });
        if (t !== 'easyeda') lib.symbols.forEach((sy, i) => { tot.items++; const d = symbolDiff(sy, syms[i]); if (d.length) { tot.problems++; if (tot.samples.length < 8) tot.samples.push(...d.slice(0, 2)); } });
        else lib.symbols.forEach(sy => { tot.items++; const parts = syms.filter(x => x.name === sy.name || x.name.startsWith(sy.name + '.')); const merged = { ...sy, units: parts.flatMap(p => p.units) }; const d = symbolDiff(sy, merged); if (d.length) { tot.problems++; if (tot.samples.length < 8) tot.samples.push(...d.slice(0, 2)); } });
      } catch (e) { tot.problems++; tot.samples.push(`${file} -> ${t}: ${(e as Error).stack?.split('\n').slice(0, 3).join(' ')}`); }
    }
  }
}
for (const [k, v] of Object.entries(totals)) console.log(`${k}: ${v.items - v.problems}/${v.items} exact`, v.samples.slice(0, 8));
