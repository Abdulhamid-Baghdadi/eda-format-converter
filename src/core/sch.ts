/** Schematic helpers shared by all formats: pin placement and connectivity (netlist). */
import type { Pin, Pt, Schematic, Sheet, SymbolInstance } from './model';
import { rotDown, add, round, normAngle } from './geom';

/** Symbol-local (Y-up) point -> sheet (Y-down) point for an instance. */
export function placeSym(inst: Pick<SymbolInstance, 'at' | 'rotation' | 'mirror'>, p: Pt): Pt {
  // KiCad order: rotate the (Y-flipped) symbol, then mirror it about the instance's own axes
  let q = rotDown({ x: p.x, y: -p.y }, inst.rotation);
  if (inst.mirror === 'y') q = { x: -q.x, y: q.y };
  else if (inst.mirror === 'x') q = { x: q.x, y: -q.y };
  const w = add(inst.at, q);
  return { x: round(w.x, 4), y: round(w.y, 4) };
}
/** Inverse of placeSym. */
export function unplaceSym(inst: Pick<SymbolInstance, 'at' | 'rotation' | 'mirror'>, w: Pt): Pt {
  let q = { x: w.x - inst.at.x, y: w.y - inst.at.y };
  if (inst.mirror === 'y') q = { x: -q.x, y: q.y };
  else if (inst.mirror === 'x') q = { x: q.x, y: -q.y };
  q = rotDown(q, -inst.rotation);
  return { x: round(q.x, 4), y: round(-q.y, 4) };
}

/** Pins of an instance (its unit, plus pins shared by all units) with sheet positions. */
export function instancePins(s: Schematic, inst: SymbolInstance): { pin: Pin; at: Pt }[] {
  const def = s.symbols[inst.lib];
  if (!def) return [];
  const unit = def.units[inst.unit - 1] ?? def.units[0];
  return unit ? unit.pins.map(pin => ({ pin, at: placeSym(inst, pin.at) })) : [];
}

/** Direction a pin points away from the body, in sheet coordinates (for label/wire stubs). */
export function pinOutward(inst: SymbolInstance, pin: Pin): number {
  // pin.angle points from the connection point to the body (Y-up); outward is the opposite
  let a = normAngle(pin.angle + 180 + inst.rotation);
  if (inst.mirror === 'y') a = normAngle(180 - a);
  else if (inst.mirror === 'x') a = normAngle(-a);
  return a;
}

const key = (p: Pt) => `${Math.round(p.x * 100)},${Math.round(p.y * 100)}`;

class DSU {
  p = new Map<string, string>();
  find(a: string): string { let r = a; while (this.p.has(r) && this.p.get(r) !== r) r = this.p.get(r)!; let c = a; while (c !== r) { const n = this.p.get(c)!; this.p.set(c, r); c = n; } if (!this.p.has(r)) this.p.set(r, r); return r; }
  union(a: string, b: string) { const x = this.find(a), y = this.find(b); if (x !== y) this.p.set(x, y); }
}

const onSeg = (p: Pt, a: Pt, b: Pt) => {
  const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (len === 0 || Math.abs(cross) / len > 0.005) return false;
  const t = ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / (len * len);
  return t > -1e-6 && t < 1 + 1e-6;
};

export interface Netlist {
  /** net name (from labels/power symbols) or '' for unnamed -> pins "REF.pin" */
  nets: { name: string; pins: string[] }[];
}

/**
 * Connectivity of a whole schematic: wires join at shared end points and where an end point lands on a wire,
 * pins connect where they touch a wire end/segment or another pin, labels name what they touch,
 * equal local label names join within a sheet, global/hierarchical labels and power symbols join across sheets.
 */
export function netlist(s: Schematic): Netlist {
  const d = new DSU();
  const names = new Map<string, Set<string>>(); // node -> names
  const pinNodes: { node: string; id: string }[] = [];
  // Bus vectors (NAME[a..b]) on labels that cross sheets carry their member nets between sheets:
  // members named in a local label on any sheet then connect design-wide.
  const busMembers = new Set<string>();
  for (const sh of s.sheets) for (const l of sh.labels) {
    const m = /^(.*)\[(\d+)\.\.(\d+)\]$/.exec(l.text);
    if (m && l.kind !== 'local') { const [a, b] = [+m[2], +m[3]].sort((x, y) => x - y); for (let i = a; i <= b; i++) busMembers.add(`${m[1]}${i}`); }
  }
  const nameNode = (n: string, global: boolean, sheet: number) => (global || busMembers.has(n) ? `G:${n}` : `L${sheet}:${n}`);
  s.sheets.forEach((sh: Sheet, si) => {
    const P = (p: Pt) => `${si}@${key(p)}`;
    // points that can connect
    const pts: Pt[] = [];
    for (const w of sh.wires) { d.union(P(w.a), P(w.b)); pts.push(w.a, w.b); }
    const attach = (p: Pt) => {
      const k = P(p);
      d.find(k);
      for (const w of sh.wires) if (onSeg(p, w.a, w.b)) d.union(k, P(w.a));
      return k;
    };
    for (const w of sh.wires) for (const e of [w.a, w.b]) for (const o of sh.wires) if (o !== w && onSeg(e, o.a, o.b)) d.union(P(e), P(o.a));
    for (const j of sh.junctions) attach(j);
    for (const l of sh.labels) {
      const k = attach(l.at);
      const nn = nameNode(l.text, l.kind !== 'local', si);
      d.union(k, nn);
      const set = names.get(nn) ?? new Set(); set.add(l.text); names.set(nn, set);
    }
    for (const inst of sh.symbols) {
      const def = s.symbols[inst.lib];
      for (const { pin, at } of instancePins(s, inst)) {
        const k = attach(at);
        if (def?.power) {
          // only a power input pin names a global net (PWR_FLAG-style symbols just mark a driver)
          if (pin.type !== 'power_in') continue;
          const n = inst.value || pin.name;
          const nn = nameNode(n, true, si);
          d.union(k, nn);
          const set = names.get(nn) ?? new Set(); set.add(n); names.set(nn, set);
        } else {
          // hidden power-input pins connect to the global net of their name (KiCad and Eagle both do this)
          if (pin.hidden && pin.type === 'power_in' && pin.name) {
            const nn = nameNode(pin.name, true, si);
            d.union(k, nn);
            const set = names.get(nn) ?? new Set(); set.add(pin.name); names.set(nn, set);
          }
          // references starting with '#' are power/flag symbols, not parts
          if ((pin.number || pin.name) && !inst.ref.startsWith('#')) pinNodes.push({ node: k, id: `${inst.ref}.${pin.number || pin.name}` });
        }
      }
    }
  });
  const groups = new Map<string, { name: string; pins: Set<string> }>();
  for (const { node, id } of pinNodes) {
    const r = d.find(node);
    let g = groups.get(r);
    if (!g) { g = { name: '', pins: new Set() }; groups.set(r, g); }
    g.pins.add(id);
  }
  for (const [nn, set] of names) { const g = groups.get(d.find(nn)); if (g && !g.name) g.name = [...set].sort()[0]; }
  return { nets: [...groups.values()].map(g => ({ name: g.name, pins: [...g.pins].sort() })).filter(g => g.pins.length) };
}

/** Compare two netlists as partitions of pins (net names ignored). */
export function netlistDiff(a: Netlist, b: Netlist): string[] {
  const sig = (n: Netlist) => new Set(n.nets.filter(x => x.pins.length > 1).map(x => x.pins.join(' ')));
  const sa = sig(a), sb = sig(b);
  const out: string[] = [];
  for (const x of sa) if (!sb.has(x)) out.push(`only in first: ${x}`);
  for (const x of sb) if (!sa.has(x)) out.push(`only in second: ${x}`);
  return out;
}

/** Points where three or more wire ends meet, or a wire end lands inside another wire: a junction dot belongs there. */
export function junctionPoints(sh: Sheet): Pt[] {
  const count = new Map<string, { p: Pt; n: number }>();
  for (const w of sh.wires) for (const e of [w.a, w.b]) { const k = key(e); const c = count.get(k) ?? { p: e, n: 0 }; c.n++; count.set(k, c); }
  const out = new Map<string, Pt>();
  for (const { p, n } of count.values()) if (n >= 3) out.set(key(p), p);
  for (const w of sh.wires) for (const e of [w.a, w.b]) for (const o of sh.wires) {
    if (o === w || key(e) === key(o.a) || key(e) === key(o.b)) continue;
    if (onSeg(e, o.a, o.b)) out.set(key(e), e);
  }
  for (const j of sh.junctions) out.set(key(j), j);
  return [...out.values()];
}

export interface SheetNet {
  name: string;
  wires: number[]; labels: number[]; junctions: Pt[];
  pins: { inst: number; pin: Pin; at: Pt }[];
}
/**
 * Nets per sheet with their wires, labels and pins (for formats that store nets explicitly, like Eagle).
 * Names come from labels and power symbols; unnamed nets get N$1, N$2 ...; a local name used on several
 * sheets for different nets gets a sheet suffix, because Eagle net names are global.
 */
export function sheetNets(s: Schematic): SheetNet[][] {
  const busMembers = new Set<string>();
  for (const sh of s.sheets) for (const l of sh.labels) {
    const m = /^(.*)\[(\d+)\.\.(\d+)\]$/.exec(l.text);
    if (m && l.kind !== 'local') { const [a, b] = [+m[2], +m[3]].sort((x, y) => x - y); for (let i = a; i <= b; i++) busMembers.add(`${m[1]}${i}`); }
  }
  let auto = 0;
  const localNames = new Map<string, number>();
  return s.sheets.map((sh, si) => {
    const d = new DSU();
    const P = (p: Pt) => key(p);
    for (const w of sh.wires) d.union(P(w.a), P(w.b));
    for (const w of sh.wires) for (const e of [w.a, w.b]) for (const o of sh.wires) if (o !== w && onSeg(e, o.a, o.b)) d.union(P(e), P(o.a));
    const attach = (p: Pt) => { const k = P(p); d.find(k); for (const w of sh.wires) if (onSeg(p, w.a, w.b)) d.union(k, P(w.a)); return k; };
    const groups = new Map<string, SheetNet & { names: { n: string; global: boolean }[] }>();
    const g = (k: string) => { const r = d.find(k); let x = groups.get(r); if (!x) { x = { name: '', wires: [], labels: [], junctions: [], pins: [], names: [] }; groups.set(r, x); } return x; };
    // labels with the same local name on this sheet are one net
    sh.labels.forEach(l => { const k = attach(l.at); if (l.kind === 'local') d.union(k, `name:${l.text}`); });
    sh.symbols.forEach(inst => { for (const { at } of instancePins(s, inst)) attach(at); });
    for (const j of sh.junctions) attach(j);
    sh.wires.forEach((w, i) => g(P(w.a)).wires.push(i));
    sh.labels.forEach((l, i) => { const x = g(P(l.at)); x.labels.push(i); x.names.push({ n: l.text, global: l.kind !== 'local' || busMembers.has(l.text) }); });
    for (const j of sh.junctions) g(P(j)).junctions.push(j);
    sh.symbols.forEach((inst, ii) => {
      const def = s.symbols[inst.lib];
      for (const { pin, at } of instancePins(s, inst)) {
        const x = g(P(at));
        x.pins.push({ inst: ii, pin, at });
        if (def?.power && pin.type === 'power_in') x.names.push({ n: inst.value || pin.name, global: true });
        else if (!def?.power && pin.hidden && pin.type === 'power_in' && pin.name) x.names.push({ n: pin.name, global: true });
      }
    });
    const out: SheetNet[] = [];
    for (const x of groups.values()) {
      if (!x.wires.length && !x.pins.length && !x.labels.length) continue;
      const glob = x.names.find(n => n.global);
      let name = glob?.n ?? x.names[0]?.n ?? '';
      if (name && !glob) {
        // local name: keep it unless another sheet already used it for a different net
        const prev = localNames.get(name);
        if (prev !== undefined && prev !== si) name = `${name}_S${si + 1}`;
        else localNames.set(name, si);
      }
      if (!name) { if (x.pins.length + x.wires.length === 0) continue; name = `N$${++auto}`; }
      out.push({ name, wires: x.wires, labels: x.labels, junctions: x.junctions, pins: x.pins });
    }
    return out;
  });
}
