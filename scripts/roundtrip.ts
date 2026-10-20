// node dist/roundtrip.mjs file.kicad_pcb outdir  -> converts KiCad -> {eagle, easyeda, kicad} and back, diffs, and runs KiCad's own Eagle importer on our .brd
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, basename } from 'node:path';
import { readFile, writeDesign } from '../src/core/index';
import { readKicadPcb } from '../src/core/kicad/read';
import { boardDiff } from '../tests/boardDiff';
const K = 'C:/Program Files/KiCad/10.0/bin/kicad-cli.exe';
const [file, out] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const src = readFile({ name: basename(file), data: new Uint8Array(readFileSync(file)) })[0];
if (src.design.kind !== 'board') throw new Error('board expected');
const A = src.design.board;
for (const t of ['kicad', 'eagle', 'easyeda'] as const) {
  const o = writeDesign(src.design, t)[0];
  const p = join(out, `${t}-${o.name}`);
  writeFileSync(p, o.data);
  const back = readFile({ name: o.name, data: o.data as string })[0].design;
  if (back.kind !== 'board') throw new Error();
  const d = boardDiff(A, back.board);
  console.log(`${basename(file)} -> ${t} -> ours: ${d.problems.length} problems (pads ${d.pads}, tracks ${d.tracks}, vias ${d.vias})`, d.problems.slice(0, 6));
  if (t === 'eagle') {
    const ref = join(out, 'kicad-import-of-ours.kicad_pcb');
    execFileSync(K, ['pcb', 'import', '--format', 'eagle', '-o', ref, p], { stdio: 'pipe' });
    const d2 = boardDiff(back.board, readKicadPcb(readFileSync(ref, 'utf8')), { checkSizes: false });
    console.log(`   our Eagle reader vs KiCad's Eagle importer on the same .brd: ${d2.problems.length} problems`, d2.problems.slice(0, 6));
  }
  if (t === 'kicad') {
    const r = execFileSync(K, ['pcb', 'drc', '--schematic-parity', '--format', 'json', '-o', join(out, 'drc.json'), p], { stdio: 'pipe' }).toString();
    void r;
  }
}
