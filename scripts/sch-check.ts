// Local check: our schematic connectivity vs KiCad's netlist (kicad-cli sch export netlist), before and after conversion.
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, basename, dirname } from 'node:path';
import { readFile, writeDesign, type Target } from '../src/core/index';
import { netlist, netlistDiff, type Netlist } from '../src/core/sch';
const K = 'C:/Program Files/KiCad/10.0/bin/kicad-cli.exe';
export function kicadNetlist(file: string, out: string): Netlist {
  const x = join(out, basename(file) + '.net.xml');
  execFileSync(K, ['sch', 'export', 'netlist', '--format', 'kicadxml', '-o', x, file], { stdio: 'pipe', timeout: 120000 });
  const s = readFileSync(x, 'utf8');
  const nets: Netlist['nets'] = [];
  for (const m of s.matchAll(/<net code="\d+" name="([^"]*)"[^>]*>([\s\S]*?)<\/net>/g)) {
    const pins = [...m[2].matchAll(/<node ref="([^"]+)" pin="([^"]+)"/g)].filter(n => !n[1].startsWith('#')).map(n => `${n[1]}.${n[2]}`).sort();
    if (pins.length) nets.push({ name: m[1], pins });
  }
  return { nets };
}
const [file, out, ...targets] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const data = new Uint8Array(readFileSync(file));
const src = readFile({ name: basename(file), data })[0];
if (src.design.kind !== 'schematic') throw new Error('schematic expected');
const ours = netlist(src.design.schematic);
const ref = file.endsWith('.kicad_sch') ? kicadNetlist(file, out) : process.env.KROOT ? kicadNetlist(process.env.KROOT, out) : null;
const multi = (n: Netlist) => n.nets.filter(x => x.pins.length > 1).length;
if (ref) { const d = netlistDiff(ours, ref); console.log(`${basename(file)}: our reader vs KiCad netlist: ${multi(ours)}/${multi(ref)} nets, ${d.length} differences`, d.slice(0, 4)); }
for (const t of (targets.length ? targets : ['kicad']) as Target[]) {
  const outs = writeDesign(src.design, t);
  const dir = join(out, t);
  for (const o of outs) { const p = join(dir, o.name); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, o.data); }
  const back = readFile({ name: outs[0].name, data: outs.length > 1 ? zipOf(outs) : (outs[0].data as string) })[0].design;
  if (back.kind !== 'schematic') throw new Error();
  const d = netlistDiff(ours, netlist(back.schematic));
  console.log(`  -> ${t} -> ours: ${d.length} differences`, d.slice(0, 4));
  if (t === 'kicad') { const kn = kicadNetlist(join(dir, outs[0].name), out); const d2 = netlistDiff(ours, kn); console.log(`  -> kicad, KiCad's netlist of our file: ${d2.length} differences`, d2.slice(0, 4)); }
}
import { zipSync, strToU8 } from 'fflate';
function zipOf(o: { name: string; data: string | Uint8Array }[]) { const z: Record<string, Uint8Array> = {}; for (const f of o) z[f.name] = typeof f.data === 'string' ? strToU8(f.data) : f.data; return zipSync(z); }
void readdirSync;
