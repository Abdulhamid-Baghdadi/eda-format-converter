// Local check: our PcbLib reader vs AltiumSharp's JSON dumps of the same files (pad name, position, size).
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readFile } from '../src/core/index';
const dir = process.argv[2];
let total = 0, bad = 0, fpCount = 0;
for (const f of readdirSync(dir).filter(x => /\.pcblib$/i.test(x))) {
  const jf = readdirSync(dir).find(x => x.toLowerCase() === f.toLowerCase().replace(/\.pcblib$/, '.json'));
  if (!jf) continue;
  let txt = readFileSync(join(dir, jf), 'utf8').replace(/\bNaN\b/g, 'null').replace(/-?Infinity/g, 'null').replace(/([^,{\[\s])(\s*\n\s*")/g, '$1,$2');
  let j: any;
  try { j = JSON.parse(txt); } catch (e) { console.log('json fail', jf, (e as Error).message.slice(0, 60)); continue; }
  const lib = readFile({ name: f, data: new Uint8Array(readFileSync(join(dir, f))) })[0].design;
  if (lib.kind !== 'library') continue;
  for (const jfp of j.footprints) {
    const fp = lib.library.footprints.find(x => x.name === jfp.name);
    fpCount++;
    if (!fp) { console.log('missing footprint', jfp.name); bad++; continue; }
    const jp = jfp.primitives.filter((p: any) => p.objectType === 'Pad');
    for (const p of jp) {
      total++;
      const x = p.location?.x?.mm ?? p.x?.mm, y = p.location?.y?.mm ?? p.y?.mm;
      const ours = fp.pads.filter(q => q.number === (p.designator ?? p.name));
      const hit = ours.find(q => Math.abs(q.at.x - (x - 1270)) < 0.002 && Math.abs(-q.at.y - (y - 1270)) < 0.002);
      if (!hit) { bad++; if (bad < 6) console.log('pad mismatch', jfp.name, p.designator, x - 1270, y - 1270, ours.map(q => q.at)); continue; }
      const sx = p.topXSize?.mm, sy = p.topYSize?.mm;
      if (sx !== undefined && (Math.abs(hit.w - sx) > 0.002 || Math.abs(hit.h - sy) > 0.002)) { bad++; if (bad < 6) console.log('size mismatch', jfp.name, p.designator, sx, sy, hit.w, hit.h); }
    }
    if (jp.length !== fp.pads.length) console.log('pad count', jfp.name, jp.length, fp.pads.length);
  }
}
console.log(`footprints ${fpCount}, pads ${total}, mismatches ${bad}`);
