/**
 * Minimal reader for Microsoft Compound File Binary (OLE2) containers, which Altium uses for
 * .PcbDoc, .PcbLib, .SchDoc and .SchLib. Returns every stream by its path, e.g. "Board6/Data".
 * Implemented from the published [MS-CFB] specification.
 */
export function readCfb(buf: Uint8Array): Map<string, Uint8Array> {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const sig = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
  if (!sig.every((b, i) => buf[i] === b)) throw new Error('Not an OLE compound file');
  const u32 = (o: number) => dv.getUint32(o, true);
  const sectorSize = 1 << dv.getUint16(0x1e, true);
  const miniSize = 1 << dv.getUint16(0x20, true);
  const firstDir = u32(0x30);
  const cutoff = u32(0x38);
  const firstMiniFat = u32(0x3c);
  const firstDifat = u32(0x44);
  const nDifat = u32(0x48);
  const off = (s: number) => (s + 1) * sectorSize;
  const END = 0xfffffffe;

  // FAT sector list from the header DIFAT and DIFAT chain
  const fatSectors: number[] = [];
  for (let i = 0; i < 109; i++) { const s = u32(0x4c + i * 4); if (s < 0xfffffffa) fatSectors.push(s); }
  let d = firstDifat;
  for (let k = 0; k < nDifat && d < 0xfffffffa; k++) {
    const per = sectorSize / 4 - 1;
    for (let i = 0; i < per; i++) { const s = u32(off(d) + i * 4); if (s < 0xfffffffa) fatSectors.push(s); }
    d = u32(off(d) + per * 4);
  }
  const fat = new Uint32Array(fatSectors.length * (sectorSize / 4));
  fatSectors.forEach((s, i) => { for (let j = 0; j < sectorSize / 4; j++) fat[i * (sectorSize / 4) + j] = u32(off(s) + j * 4); });
  const chain = (start: number, table: Uint32Array) => { const out: number[] = []; let s = start; const seen = new Set<number>(); while (s !== END && s < table.length && !seen.has(s)) { seen.add(s); out.push(s); s = table[s]; } return out; };
  const readChain = (start: number) => { const ss = chain(start, fat); const r = new Uint8Array(ss.length * sectorSize); ss.forEach((s, i) => r.set(buf.subarray(off(s), off(s) + sectorSize), i * sectorSize)); return r; };

  const dir = readChain(firstDir);
  const ddv = new DataView(dir.buffer);
  interface Entry { name: string; type: number; left: number; right: number; child: number; start: number; size: number }
  const entries: Entry[] = [];
  for (let o = 0; o + 128 <= dir.length; o += 128) {
    const nlen = ddv.getUint16(o + 64, true);
    let name = '';
    for (let i = 0; i + 2 < nlen; i += 2) name += String.fromCharCode(ddv.getUint16(o + i, true));
    entries.push({ name, type: dir[o + 66], left: ddv.getUint32(o + 68, true), right: ddv.getUint32(o + 72, true), child: ddv.getUint32(o + 76, true), start: ddv.getUint32(o + 116, true), size: ddv.getUint32(o + 120, true) });
  }
  const root = entries[0];
  const miniStream = readChain(root.start);
  const miniFatRaw = firstMiniFat < 0xfffffffa ? readChain(firstMiniFat) : new Uint8Array(0);
  const miniFat = new Uint32Array(miniFatRaw.buffer, 0, Math.floor(miniFatRaw.length / 4));

  const streamData = (e: Entry) => {
    if (e.size < cutoff) {
      const ss = chain(e.start, miniFat);
      const r = new Uint8Array(ss.length * miniSize);
      ss.forEach((s, i) => r.set(miniStream.subarray(s * miniSize, (s + 1) * miniSize), i * miniSize));
      return r.subarray(0, e.size);
    }
    return readChain(e.start).subarray(0, e.size);
  };

  const out = new Map<string, Uint8Array>();
  const walk = (id: number, prefix: string, depth: number) => {
    if (id >= entries.length || id === 0xffffffff || depth > 4096) return;
    const e = entries[id];
    walk(e.left, prefix, depth + 1);
    walk(e.right, prefix, depth + 1);
    const p = prefix + e.name;
    if (e.type === 2) out.set(p, streamData(e));
    else if (e.type === 1) walk(e.child, p + '/', depth + 1);
  };
  walk(root.child, '', 0);
  return out;
}
