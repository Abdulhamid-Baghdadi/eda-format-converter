import { readFileSync, readdirSync } from 'node:fs';
import { readFile } from '../src/core/index';
for (const f of readdirSync('public/samples').filter(f => !f.endsWith('.md'))) {
  for (const r of readFile({ name: f, data: new Uint8Array(readFileSync('public/samples/' + f)) })) {
    const d = r.design;
    if (d.kind === 'board') { const b = d.board; console.log(`${f}: BOARD ${b.footprints.length} footprints, ${b.footprints.reduce((n, x) => n + x.footprint.pads.length, 0)} pads, ${b.tracks.length} tracks, ${b.vias.length} vias, ${b.zones.length} zones, outline ${b.graphics.filter(g => g.layer === 'Edge.Cuts').length} segs, ${b.copperLayers} layers`); }
    else console.log(`${f}: LIBRARY ${d.library.symbols.length} symbols (${d.library.symbols.map(s => s.name).join(', ')}), ${d.library.footprints.length} footprints (${d.library.footprints.map(x => x.name).join(', ')})`);
  }
}
