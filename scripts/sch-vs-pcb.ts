// Local check: netlist of an Altium schematic vs the nets of the matching Altium board (pin = pad number).
import { readFileSync } from 'node:fs';
import { readFile } from '../src/core/index';
import { netlist } from '../src/core/sch';
const rd = (f: string) => readFile({ name: f, data: new Uint8Array(readFileSync(f)) }).map(r => r.design);
const schs = process.argv.slice(3).flatMap(rd);
const brd = rd(process.argv[2])[0];
if (brd.kind !== 'board') throw 0;
const board = new Map<string, Set<string>>();
for (const f of brd.board.footprints) for (const p of f.footprint.pads) if (p.net && p.number) { const s = board.get(p.net) ?? new Set(); s.add(`${f.ref}.${p.number}`); board.set(p.net, s); }
const refs = new Set(brd.board.footprints.map(f => f.ref));
let same = 0, total = 0; const bad: string[] = [];
for (const d of schs) {
  if (d.kind !== 'schematic') continue;
  for (const n of netlist(d.schematic).nets) {
    const pins = n.pins.filter(p => refs.has(p.split('.')[0]));
    if (pins.length < 2) continue;
    total++;
    // every pin of this schematic net must sit on one board net
    const nets = new Set(pins.map(p => [...board].find(([, s]) => s.has(p))?.[0] ?? '?'));
    if (nets.size === 1 && !nets.has('?')) same++; else if (bad.length < 6) bad.push(`${n.name}: ${pins.join(' ')} -> ${[...nets].join(',')}`);
  }
}
console.log(`schematic nets whose pins all share one board net: ${same}/${total}`, bad);
