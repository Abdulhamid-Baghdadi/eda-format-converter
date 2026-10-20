/** Support matrix shown in the app (kept in sync with the README). */
export const MATRIX: { item: string; kicad: string; eagle: string; easyeda: string }[] = [
  { item: 'Footprints: SMD / THT / NPTH pads', kicad: '✅', eagle: '✅', easyeda: '✅' },
  { item: 'Pad shapes', kicad: '✅ all (trapezoid → rect)', eagle: '⚠️ THT pads: round, square, octagon, 2:1 long only', easyeda: '⚠️ no rounded rect (→ rect)' },
  { item: 'Slotted holes', kicad: '✅', eagle: '⚠️ round drill', easyeda: '✅' },
  { item: 'Silk / fab / courtyard / mask / paste graphics', kicad: '✅', eagle: '✅', easyeda: '✅ (courtyard → Mechanical)' },
  { item: 'Arcs, circles, polygons', kicad: '✅', eagle: '✅', easyeda: '✅' },
  { item: '3D model reference', kicad: '✅', eagle: '❌ dropped', easyeda: '⚠️ name only' },
  { item: 'Symbols: pins (type, shape, hidden), body graphics', kicad: '✅', eagle: '✅', easyeda: '✅' },
  { item: 'Multi-unit symbols', kicad: '✅ units', eagle: '✅ gates', easyeda: '⚠️ one symbol per unit' },
  { item: 'Symbol ↔ footprint pin mapping', kicad: '✅ by pad number', eagle: '✅ connects', easyeda: '✅ by pad number' },
  { item: 'Boards: footprints (top & bottom, any angle)', kicad: '✅', eagle: '✅', easyeda: '✅' },
  { item: 'Tracks, arcs, vias', kicad: '✅', eagle: '✅', easyeda: '✅ (through vias)' },
  { item: 'Nets', kicad: '✅', eagle: '✅ signals', easyeda: '✅' },
  { item: 'Copper zones / keepouts', kicad: '✅ (refill after opening)', eagle: '✅ polygons / restrict', easyeda: '✅ copper areas / cutouts' },
  { item: 'Board outline, holes, text', kicad: '✅', eagle: '✅', easyeda: '✅' },
  { item: 'Copper layers', kicad: '✅ up to 32', eagle: '✅ up to 16', easyeda: '✅ up to 34' },
  { item: 'Schematics: symbols, wires, junctions, labels', kicad: '✅', eagle: '✅ (no-connects dropped)', easyeda: '✅' },
  { item: 'Power symbols', kicad: '✅', eagle: '✅ supply symbols', easyeda: '✅ net flags (no PWR_FLAG)' },
  { item: 'Multi-sheet / hierarchical schematics', kicad: '✅ flattened, hierarchical → global labels', eagle: '✅ sheets', easyeda: '✅ one file per sheet' },
  { item: 'Schematic pin numbers', kicad: '✅', eagle: '⚠️ on a placeholder package', easyeda: '✅' },
  { item: 'Design rules, net classes, dimensions, images', kicad: '❌', eagle: '❌', easyeda: '❌' },
];
/** What the Altium reader takes in (Altium is input-only). */
export const ALTIUM_IN = 'Altium Designer / CircuitMaker binary files are read (not written): .SchDoc schematics (components, wires, net labels, power ports, ports, junctions), .PcbDoc boards (components, pads incl. slots and rounded rects, tracks, arcs, vias, nets, polygon pours, copper regions and fills, cutouts, board outline, text), .PcbLib footprints and .SchLib symbols (multi-part, binary pins, footprint link). Mechanical layers go to Dwgs.User; 3D bodies, rules and dimensions are dropped.';
export const FORMAT_NOTES: Record<string, string> = {
  kicad: 'KiCad 8 format (opens in KiCad 8, 9, 10)',
  eagle: 'Eagle 9 XML (Eagle 6+, Fusion Electronics, and KiCad’s importer)',
  easyeda: 'EasyEDA Standard JSON (File ▸ Open ▸ EasyEDA Source)',
};
