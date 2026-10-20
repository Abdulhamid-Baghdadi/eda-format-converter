/**
 * EasyEDA Standard schematics (docType 1): read and write.
 * Placed symbols (LIB) carry their shapes already placed on the sheet, so each placement becomes a symbol
 * definition in its placed orientation. Units are 10 mil, Y down. EasyEDA net labels and net flags are global.
 */
import type { Graphic, Pin, Pt, Schematic, Sheet, Symbol, SymbolUnit, Text } from '../model';
import { normAngle, round } from '../geom';
import { readEasySymbol, parseBacktick, U, type EeDoc } from './read';
import { unitShapes, Ids } from './write';
import { placeSym, pinOutward, instancePins } from '../sch';
import { Report } from '../report';

const n = (s: string | undefined, d = 0) => { const v = parseFloat(s ?? ''); return Number.isFinite(v) ? v : d; };
const M = (x: number, y: number): Pt => ({ x: round(x * U, 4), y: round(y * U, 4) });

export function readEasySchematic(docs: EeDoc[], r = new Report(), name = 'schematic'): Schematic {
  const symbols: Record<string, Symbol> = {};
  const sigs = new Map<string, string>();
  const sheets = docs.map((doc, di): Sheet => {
    const sh: Sheet = { name: (doc as { title?: string }).title ?? `Sheet ${di + 1}`, symbols: [], wires: [], buses: [], junctions: [], noConnects: [], labels: [], graphics: [] };
    for (const s of doc.shape ?? []) {
      const kind = s.slice(0, s.indexOf('~'));
      if (kind === 'LIB') {
        const parts = s.split('#@$');
        const h = parts[0].split('~');
        const ox = n(h[1]), oy = n(h[2]);
        const attrs = parseBacktick(h[3]);
        const sub = parts.slice(1);
        const def = readEasySymbol({ head: { x: ox, y: oy, c_para: attrs }, shape: sub }, new Report());
        const txt = (mark: string) => sub.find(x => x.startsWith(`T~${mark}~`))?.split('~');
        const refRaw = txt('P')?.[12] ?? attrs.pre ?? 'U?';
        const m = /^(.*?)\.(\d+)$/.exec(refRaw);
        const ref = m ? m[1] : refRaw;
        const value = txt('N')?.[12] ?? attrs.Value ?? attrs.name ?? '';
        def.name = attrs.name ?? (attrs.package ? `${ref.replace(/\d+$/, '')}_${attrs.package}` : 'part');
        const sig = JSON.stringify([def.name, def.units]);
        let key = sigs.get(sig);
        if (!key) { key = `${def.name}#${sigs.size + 1}`; sigs.set(sig, key); symbols[key] = def; }
        const T = (f?: string[]): Text | undefined => f ? { type: 'text', at: M(n(f[2]), n(f[3])), text: f[12] ?? '', size: 1.27, width: 0, rotation: normAngle(n(f[4])), layer: 'symbol', justify: 'left', hidden: f[13] === '0' } : undefined;
        sh.symbols.push({ ref, value, footprint: attrs.package || undefined, lib: key, unit: 1, at: M(ox, oy), rotation: 0, refText: T(txt('P')), valueText: T(txt('N')), properties: {} });
        if (m && +m[2] > 1) r.approx('sub-part', `${refRaw}: EasyEDA sub-parts are separate symbols; pins keep their numbers`);
        r.ok('symbol instance');
        continue;
      }
      const f = s.split('~');
      switch (kind) {
        case 'W': {
          const nums = f[1].trim().split(/[\s,]+/).map(Number);
          for (let i = 2; i + 1 < nums.length; i += 2) sh.wires.push({ a: M(nums[i - 2], nums[i - 1]), b: M(nums[i], nums[i + 1]) });
          r.ok('wire'); break;
        }
        case 'B': {
          const nums = f[1].trim().split(/[\s,]+/).map(Number);
          for (let i = 2; i + 1 < nums.length; i += 2) sh.buses.push({ a: M(nums[i - 2], nums[i - 1]), b: M(nums[i], nums[i + 1]) });
          r.ok('bus'); break;
        }
        case 'J': sh.junctions.push(M(n(f[1]), n(f[2]))); r.ok('junction'); break;
        case 'O': sh.noConnects.push(M(n(f[1]), n(f[2]))); r.ok('no-connect'); break;
        case 'N': sh.labels.push({ text: f[5] ?? '', at: M(n(f[1]), n(f[2])), rotation: normAngle(n(f[3])), kind: 'global' }); r.ok('net label'); break;
        case 'F': {
          // net flag (power, ground, net port): connection point in the 2nd part, name in the 3rd
          const segs = s.split('^^');
          const pt = segs[1]?.split('~') ?? [];
          const name = segs[2]?.split('~')[0] ?? '';
          sh.labels.push({ text: name, at: M(n(pt[0]), n(pt[1])), rotation: normAngle(n(f[4])), kind: 'global' });
          r.ok('net flag'); break;
        }
        case 'T': if (f[1] === 'L') { sh.graphics.push({ type: 'text', at: M(n(f[2]), n(f[3])), text: f[12] ?? '', size: 1.27, width: 0, rotation: normAngle(n(f[4])), layer: 'Notes', justify: 'left' }); r.ok('text'); } break;
        case 'PL': {
          const nums = f[1].trim().split(/[\s,]+/).map(Number);
          const pts: Pt[] = []; for (let i = 0; i + 1 < nums.length; i += 2) pts.push(M(nums[i], nums[i + 1]));
          sh.graphics.push({ type: 'poly', pts, width: n(f[3], 1) * U, layer: 'Notes', closed: false }); r.ok('drawing'); break;
        }
        case 'BE': r.skip('bus entry', 'bus entries are not converted'); break;
        default: if (kind) r.skip(kind, 'EasyEDA schematic item not converted');
      }
    }
    return sh;
  });
  return { name, symbols, sheets };
}

/** A definition unit moved into sheet space (Y up, in mm) for an instance, so it can be written with absolute shapes. */
function placedUnit(s: Schematic, inst: Sheet['symbols'][0]): SymbolUnit {
  const def = s.symbols[inst.lib];
  const u = def?.units[inst.unit - 1] ?? def?.units[0] ?? { graphics: [], pins: [] };
  const W = (p: Pt) => { const q = placeSym(inst, p); return { x: q.x, y: -q.y }; };
  const g = (x: Graphic): Graphic => {
    switch (x.type) {
      case 'line': return { ...x, a: W(x.a), b: W(x.b) };
      case 'rect': return { ...x, a: W(x.a), b: W(x.b) };
      case 'circle': return { ...x, center: W(x.center) };
      case 'arc': return inst.mirror ? { ...x, start: W(x.end), mid: W(x.mid), end: W(x.start) } : { ...x, start: W(x.start), mid: W(x.mid), end: W(x.end) };
      case 'poly': return { ...x, pts: x.pts.map(W) };
      case 'text': return { ...x, at: W(x.at), rotation: normAngle(x.rotation + inst.rotation) };
    }
  };
  const pins: Pin[] = u.pins.map(p => ({ ...p, at: W(p.at), angle: normAngle(pinOutward(inst, p) + 180) }));
  return { graphics: u.graphics.map(g), pins };
}

const FLAG: Record<string, string> = { GND: 'part_netLabel_gnD', VCC: 'part_netLabel_VCC', '+5V': 'part_netLabel_+5V' };

export function writeEasySchematic(s: Schematic, r = new Report()): { name: string; data: string }[] {
  return s.sheets.map((sh, si) => {
    const ids = new Ids();
    const X = (p: Pt) => [round(p.x / U, 3), round(p.y / U, 3)];
    const Sy = (p: Pt) => [round(p.x / U, 3), round(-p.y / U, 3)]; // Y-up sheet mm -> canvas
    const shape: string[] = [];
    for (const inst of sh.symbols) {
      const def = s.symbols[inst.lib];
      if (def?.power && !def.units[0]?.pins.some(p => p.type === 'power_in')) { r.skip('power flag', 'ERC-only power flags (PWR_FLAG) have no EasyEDA equivalent'); continue; }
      if (def?.power) {
        // power symbols become net flags named after their value
        const pinAt = instancePins(s, inst)[0]?.at ?? inst.at;
        const [x, y] = X(pinAt);
        const name = inst.value || def.units[0]?.pins[0]?.name || 'GND';
        const isGnd = /GND|VSS/i.test(name);
        const end = isGnd ? y + 10 : y - 10;
        shape.push(`F~${FLAG[name] ?? (isGnd ? 'part_netLabel_gnD' : 'part_netLabel_VCC')}~${x}~${y}~0~${ids.next()}~~0^^${x}~${y}^^${name}~#000000~${x - 10}~${isGnd ? end + 12 : end - 4}~0~start~1~Times New Roman~9pt~flag_${ids.next()}^^PL~${x} ${y} ${x} ${end}~#000000~1~0~transparent~${ids.next()}~0^^PL~${x - 6} ${end} ${x + 6} ${end}~#000000~1~0~transparent~${ids.next()}~0`);
        r.ok('power symbol');
        continue;
      }
      const u = placedUnit(s, inst);
      const [x, y] = X(inst.at);
      const ref = def && def.units.length > 1 ? `${inst.ref}.${inst.unit}` : inst.ref;
      const sub = unitShapes(u, Sy, ids);
      const rt = inst.refText?.at ?? { x: inst.at.x, y: inst.at.y - 3 }, vt = inst.valueText?.at ?? { x: inst.at.x, y: inst.at.y + 4 };
      sub.unshift(`T~N~${X(vt).join('~')}~0~#000080~Arial~~~~~comment~${inst.value}~1~start~${ids.next()}~0~pinpart`);
      sub.unshift(`T~P~${X(rt).join('~')}~0~#000080~Arial~~~~~comment~${ref}~1~start~${ids.next()}~0~pinpart`);
      const attrs = `package\`${inst.footprint?.replace(/^.*:/, '') ?? ''}\`nameAlias\`Value\`Value\`${inst.value}\`name\`${def?.name ?? ''}\`pre\`${(def?.reference ?? 'U')}?\``;
      shape.push([`LIB~${x}~${y}~${attrs}~~0~${ids.next()}~0`, ...sub].join('#@$'));
      r.ok('symbol instance');
    }
    if (sh.symbols.some(i => s.symbols[i.lib]?.power)) r.approx('power symbol', 'power symbols become EasyEDA net flags (same net name)');
    for (const w of sh.wires) shape.push(`W~${X(w.a).join(' ')} ${X(w.b).join(' ')}~#008800~1~0~none~${ids.next()}~0`);
    for (const b of sh.buses) shape.push(`B~${X(b.a).join(' ')} ${X(b.b).join(' ')}~#0000FF~2~0~none~${ids.next()}~0`);
    for (const j of sh.junctions) shape.push(`J~${X(j).join('~')}~2.5~#CC0000~${ids.next()}~0`);
    for (const nc of sh.noConnects) { const [x, y] = X(nc); shape.push(`O~${x}~${y}~${ids.next()}~M ${x - 4} ${y - 4} L ${x + 4} ${y + 4} M ${x + 4} ${y - 4} L ${x - 4} ${y + 4}~#33cc33~0`); }
    const multi = s.sheets.length > 1;
    for (const l of sh.labels) {
      // EasyEDA net labels are global; local names on other sheets get a sheet suffix so they stay separate
      const text = l.kind === 'local' && multi && si > 0 ? `${l.text}_S${si + 1}` : l.text;
      const [x, y] = X(l.at);
      shape.push(`N~${x}~${y}~${normAngle(Math.round(l.rotation / 90) * 90)}~#0000FF~${text}~${ids.next()}~start~${x}~${y - 2}~Times New Roman~7pt~`);
    }
    if (multi && sh.labels.some(l => l.kind === 'local')) r.approx('local label', 'EasyEDA net labels connect across sheets, so local labels on later sheets get a _S<n> suffix');
    for (const g of sh.graphics) {
      if (g.type === 'text') { const [x, y] = X(g.at); shape.push(`T~L~${x}~${y}~${normAngle(g.rotation)}~#0000FF~~9pt~~~~comment~${g.text}~1~start~${ids.next()}~0~`); }
      else if (g.type === 'line') shape.push(`PL~${X(g.a).join(' ')} ${X(g.b).join(' ')}~#000000~1~0~none~${ids.next()}~0`);
      else if (g.type === 'poly') shape.push(`PL~${(g.closed ? [...g.pts, g.pts[0]] : g.pts).map(p => X(p).join(' ')).join(' ')}~#000000~1~0~none~${ids.next()}~0`);
    }
    r.ok('sheet');
    const nm = s.sheets.length > 1 ? `${s.name}_${si + 1}` : s.name;
    return {
      name: `${nm}.schematic.json`,
      data: JSON.stringify({ head: { docType: '1', editorVersion: '6.5.40', newgId: true, c_para: {}, x: 0, y: 0, hasIdFlag: true, importFlag: 0, transformList: '' }, canvas: 'CA~1000~1000~#FFFFFF~yes~#CCCCCC~5~1000~1000~line~5~pixel~5~0~0', shape, BBox: { x: 0, y: 0, width: 1000, height: 1000 }, colors: {}, title: sh.name }, null, 1),
    };
  });
}
