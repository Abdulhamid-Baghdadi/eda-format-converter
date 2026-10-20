// Verification helper (local, needs KiCad): .
// Local check: our Altium reader vs KiCad's own Altium importer (kicad-cli pcb import --format altium).
import { readFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, basename } from 'node:path';
import { readFile } from '../src/core/index';
import { readKicadPcb, placeDown } from '../src/core/kicad/read';
import { boardDiff } from '../tests/boardDiff';
import type { Board } from '../src/core/model';
const K = 'C:/Program Files/KiCad/10.0/bin/kicad-cli.exe';
const [file, out] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const res = readFile({ name: basename(file), data: new Uint8Array(readFileSync(file)) })[0];
if (res.design.kind !== 'board') throw new Error('board expected');
const ours = res.design.board;
const ref = join(out, basename(file) + '.kicad_pcb');
execFileSync(K, ['pcb', 'import', '--format', 'altium', '-o', ref, file], { stdio: 'pipe', timeout: 110_000 });
const theirs = readKicadPcb(readFileSync(ref, 'utf8'));
// KiCad moves the design; find the shift from a matching pad
const padW = (b: Board) => { const m = new Map<string, { x: number; y: number }>(); for (const f of b.footprints) for (const p of f.footprint.pads) m.set(`${f.ref}.${p.number}`, placeDown(f, p.at)); return m; };
const a = padW(ours), t = padW(theirs);
const deltas: { x: number; y: number }[] = [];
for (const [k, v] of a) { const w = t.get(k); if (w) deltas.push({ x: w.x - v.x, y: w.y - v.y }); }
deltas.sort((p, q) => p.x - q.x); const dx = deltas[deltas.length >> 1]?.x ?? 0; deltas.sort((p, q) => p.y - q.y); const dy = deltas[deltas.length >> 1]?.y ?? 0;
const shift = (p: { x: number; y: number }) => ({ x: p.x + dx, y: p.y + dy });
const moved: Board = { ...ours, footprints: ours.footprints.map(f => ({ ...f, at: shift(f.at) })), tracks: ours.tracks.map(x => ({ ...x, a: shift(x.a), b: shift(x.b), mid: x.mid && shift(x.mid) })), vias: ours.vias.map(v => ({ ...v, at: shift(v.at) })), holes: ours.holes.map(h => ({ ...h, at: shift(h.at) })) };
const d = boardDiff(moved, theirs, { tol: 0.005 });
console.log(`${basename(file)}: ours fps=${ours.footprints.length} pads=${d.pads} tracks=${ours.tracks.length} vias=${ours.vias.length} zones=${ours.zones.length} layers=${ours.copperLayers} | kicad fps=${theirs.footprints.length} tracks=${theirs.tracks.length} vias=${theirs.vias.length} zones=${theirs.zones.length} | shift ${dx.toFixed(3)},${dy.toFixed(3)} | problems ${d.problems.length}`);
const kinds = new Map<string, number>(); for (const p of d.problems) { const k = p.replace(/[\d.,-]+/g, '#').slice(0, 50); kinds.set(k, (kinds.get(k) ?? 0) + 1); }
console.log([...kinds].sort((x, y) => y[1] - x[1]).slice(0, 10));
console.log(d.problems.slice(0, 8));
console.log(res.report.toText().split('\n').filter(l => !l.startsWith('converted')).join('\n'));
