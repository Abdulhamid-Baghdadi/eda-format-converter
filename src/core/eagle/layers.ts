/** Eagle layer numbers <-> canonical (KiCad-named) layers. */
const MAP: Record<string, string> = {
  '1': 'F.Cu', '16': 'B.Cu', '20': 'Edge.Cuts', '46': 'Edge.Cuts',
  '21': 'F.SilkS', '22': 'B.SilkS', '25': 'F.SilkS', '26': 'B.SilkS', '27': 'F.Fab', '28': 'B.Fab',
  '29': 'F.Mask', '30': 'B.Mask', '31': 'F.Paste', '32': 'B.Paste', '35': 'F.Adhes', '36': 'B.Adhes',
  '39': 'F.CrtYd', '40': 'B.CrtYd', '41': 'Keepout.F', '42': 'Keepout.B', '43': 'Keepout.F',
  '47': 'Dwgs.User', '48': 'Dwgs.User', '49': 'Cmts.User', '51': 'F.Fab', '52': 'B.Fab',
};
export function eagleLayerToKicad(n: string): string | null {
  if (MAP[n]) return MAP[n];
  const l = +n;
  if (l >= 2 && l <= 15) return `In${l - 1}.Cu`;
  if (l >= 100) return 'Cmts.User';
  return null; // 17 Pads, 18 Vias, 19 Unrouted, 23/24 origins, 44/45 drills ... are derived data
}

const REV: Record<string, number> = {
  'F.Cu': 1, 'B.Cu': 16, 'Edge.Cuts': 20, 'F.SilkS': 21, 'B.SilkS': 22, 'F.Fab': 51, 'B.Fab': 52, 'F.Mask': 29, 'B.Mask': 30,
  'F.Paste': 31, 'B.Paste': 32, 'F.Adhes': 35, 'B.Adhes': 36, 'F.CrtYd': 39, 'B.CrtYd': 40, 'Dwgs.User': 48, 'Cmts.User': 48,
  'Eco1.User': 48, 'Eco2.User': 48, 'Margin': 48,
};
export function kicadLayerToEagle(l: string): number {
  if (REV[l]) return REV[l];
  const m = /^In(\d+)\.Cu$/.exec(l);
  if (m) return Math.min(15, +m[1] + 1);
  return 48;
}

/** Standard Eagle layer table (subset that matters for boards and libraries). */
export const EAGLE_LAYERS: [number, string, number, number][] = [
  [1, 'Top', 4, 1], ...Array.from({ length: 14 }, (_, i) => [i + 2, `Route${i + 2}`, 1, 3] as [number, string, number, number]), [16, 'Bottom', 1, 1],
  [17, 'Pads', 2, 1], [18, 'Vias', 2, 1], [19, 'Unrouted', 6, 1], [20, 'Dimension', 15, 1], [21, 'tPlace', 7, 1], [22, 'bPlace', 7, 1],
  [23, 'tOrigins', 15, 1], [24, 'bOrigins', 15, 1], [25, 'tNames', 7, 1], [26, 'bNames', 7, 1], [27, 'tValues', 7, 1], [28, 'bValues', 7, 1],
  [29, 'tStop', 7, 3], [30, 'bStop', 7, 6], [31, 'tCream', 7, 4], [32, 'bCream', 7, 5], [35, 'tGlue', 7, 4], [36, 'bGlue', 7, 5],
  [39, 'tKeepout', 4, 11], [40, 'bKeepout', 1, 11], [41, 'tRestrict', 4, 10], [42, 'bRestrict', 1, 10], [43, 'vRestrict', 2, 10],
  [44, 'Drills', 7, 1], [45, 'Holes', 7, 1], [46, 'Milling', 3, 1], [47, 'Measures', 7, 1], [48, 'Document', 7, 1], [49, 'Reference', 7, 1],
  [51, 'tDocu', 7, 1], [52, 'bDocu', 7, 1], [91, 'Nets', 2, 1], [92, 'Busses', 1, 1], [93, 'Pins', 2, 1], [94, 'Symbols', 4, 1],
  [95, 'Names', 7, 1], [96, 'Values', 7, 1], [97, 'Info', 7, 1], [98, 'Guide', 6, 1],
];
