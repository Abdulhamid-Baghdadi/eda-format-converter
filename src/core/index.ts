import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate';
import type { Design, InputFile, OutputFile, Library } from './model';
import { Report } from './report';
import { readKicadFootprint, readKicadSymbols, readKicadPcb } from './kicad/read';
import { writeKicadFootprint, writeKicadSymbols, writeKicadPcb, kicadName } from './kicad/write';
import { readEagleLbr, readEagleBoard } from './eagle/read';
import { writeEagleLbr, writeEagleBoard } from './eagle/write';
import { readEasyEda } from './easyeda/read';
import { writeEasyFootprint, writeEasySymbol, writeEasyBoard } from './easyeda/write';

export * from './model';
export { Report } from './report';

export type Format = 'kicad' | 'eagle' | 'easyeda';
export const FORMATS: { id: Format; label: string; lib: string; board: string }[] = [
  { id: 'kicad', label: 'KiCad 6–10', lib: '.kicad_sym + .pretty/.kicad_mod', board: '.kicad_pcb' },
  { id: 'eagle', label: 'Eagle / Fusion Electronics', lib: '.lbr', board: '.brd' },
  { id: 'easyeda', label: 'EasyEDA Standard', lib: 'symbol / footprint .json', board: 'PCB .json' },
];

export interface ReadResult { file: string; format: Format; design: Design; report: Report }

const text = (d: Uint8Array | string) => (typeof d === 'string' ? d : strFromU8(d).replace(/^﻿/, ''));
const base = (name: string) => name.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '');

export class UnsupportedError extends Error {}

/** Detect the format of a file and read it into the neutral model. */
export function readFile(f: InputFile): ReadResult[] {
  const lower = f.name.toLowerCase();
  const bytes = typeof f.data === 'string' ? strToU8(f.data) : f.data;
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    if (/\.(epro|elibz?)$/.test(lower)) throw new UnsupportedError('EasyEDA Pro (.epro/.elibz) files are not supported yet — export as EasyEDA Standard JSON, or use File ▸ Export ▸ Altium/KiCad in EasyEDA Pro.');
    const entries = unzipSync(bytes);
    const out: ReadResult[] = [];
    // KiCad symbol libraries and .pretty footprints in one archive form one library, so symbol->footprint links survive
    const r = new Report();
    const kicadLib: Library = { symbols: [], footprints: [] };
    let libName = '';
    for (const [name, data] of Object.entries(entries)) {
      if (name.endsWith('/') || name.startsWith('__MACOSX')) continue;
      if (/\.kicad_mod$/i.test(name)) { kicadLib.footprints.push(readKicadFootprint(text(data), r)); continue; }
      if (/\.kicad_sym$/i.test(name)) { kicadLib.symbols.push(...readKicadSymbols(text(data), r)); libName ||= base(name); continue; }
      try { out.push(...readFile({ name, data })); } catch (e) { if (!(e instanceof UnsupportedError)) throw e; }
    }
    if (kicadLib.symbols.length || kicadLib.footprints.length) {
      out.unshift({ file: f.name, format: 'kicad', design: { kind: 'library', name: libName || base(f.name), library: kicadLib }, report: r });
    }
    if (!out.length) throw new UnsupportedError(`No supported files inside ${f.name}`);
    return out;
  }
  const src = text(f.data);
  const r = new Report();
  const name = base(f.name);
  const one = (format: Format, design: Design): ReadResult[] => [{ file: f.name, format, design, report: r }];
  const trimmed = src.trimStart();
  if (trimmed.startsWith('(')) {
    const head = /^\(\s*([a-z_]+)/.exec(trimmed)?.[1];
    if (head === 'footprint' || head === 'module') return one('kicad', { kind: 'library', name, library: { symbols: [], footprints: [readKicadFootprint(src, r)] } });
    if (head === 'kicad_symbol_lib') return one('kicad', { kind: 'library', name, library: { symbols: readKicadSymbols(src, r), footprints: [] } });
    if (head === 'kicad_pcb') return one('kicad', { kind: 'board', name, board: readKicadPcb(src, r, name) });
    if (head === 'kicad_sch') throw new UnsupportedError('KiCad schematics (.kicad_sch) are not supported yet — libraries and boards are.');
    throw new UnsupportedError(`Unknown KiCad file (${head})`);
  }
  if (trimmed.startsWith('<')) {
    if (!/<eagle[\s>]/.test(src.slice(0, 4000))) throw new UnsupportedError('XML file is not an Eagle file');
    if (/<library[\s>]/.test(src) && !/<board[\s>]/.test(src) && !/<schematic[\s>]/.test(src)) return one('eagle', { kind: 'library', name, library: readEagleLbr(src, r, name) });
    if (/<board[\s>]/.test(src)) return one('eagle', { kind: 'board', name, board: readEagleBoard(src, r, name) });
    if (/<schematic[\s>]/.test(src)) throw new UnsupportedError('Eagle schematics (.sch) are not supported yet — libraries (.lbr) and boards (.brd) are.');
    throw new UnsupportedError('Unrecognised Eagle file');
  }
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    let json: unknown;
    try { json = JSON.parse(src); } catch { throw new UnsupportedError('Invalid JSON'); }
    if (Array.isArray(json)) {
      // an array of EasyEDA documents (e.g. saved API responses)
      return json.flatMap((j, i) => readFile({ name: `${name}_${i + 1}.json`, data: JSON.stringify(j) }));
    }
    const res = readEasyEda(json, r, name);
    return one('easyeda', res.kind === 'board' ? { kind: 'board', name, board: res.board } : { kind: 'library', name, library: res.library });
  }
  if (/^EESchema|^PCBNEW-LibModule|^\$MODULE/.test(trimmed)) throw new UnsupportedError('Legacy KiCad 4/5 libraries (.lib/.mod) are not supported — open them in KiCad and save in the new format.');
  if (/^\|RECORD=|^\x00/.test(trimmed) || /\.(schdoc|pcbdoc|schlib|pcblib)$/.test(lower)) throw new UnsupportedError('Altium files are not supported yet.');
  throw new UnsupportedError(`Could not recognise ${f.name}`);
}

/** Write a design in the target format. */
export function writeDesign(d: Design, target: Format, r = new Report()): OutputFile[] {
  const name = kicadName(d.name);
  if (d.kind === 'board') {
    if (target === 'kicad') return [{ name: `${name}.kicad_pcb`, data: writeKicadPcb(d.board, r) }];
    if (target === 'eagle') return [{ name: `${name}.brd`, data: writeEagleBoard(d.board, r) }];
    return [{ name: `${name}.json`, data: writeEasyBoard(d.board, r) }];
  }
  const lib = d.library;
  const out: OutputFile[] = [];
  if (target === 'kicad') {
    if (lib.symbols.length) out.push({ name: `${name}.kicad_sym`, data: writeKicadSymbols(lib.symbols.map(s => ({ ...s, footprint: s.footprint ? `${name}:${kicadName(s.footprint.replace(/^.*:/, ''))}` : undefined })), r) });
    const used = new Set<string>();
    for (const fp of lib.footprints) {
      let fn = kicadName(fp.name);
      while (used.has(fn)) fn += '_';
      used.add(fn);
      out.push({ name: lib.footprints.length > 1 || lib.symbols.length ? `${name}.pretty/${fn}.kicad_mod` : `${fn}.kicad_mod`, data: writeKicadFootprint(fp, r) });
    }
  } else if (target === 'eagle') {
    out.push({ name: `${name}.lbr`, data: writeEagleLbr(lib, r, name) });
  } else {
    const uniq = (used: Set<string>, n: string) => { let k = kicadName(n); while (used.has(k)) k += '_'; used.add(k); return k; };
    const symNames = new Set<string>(), fpNames = new Set<string>();
    for (const s of lib.symbols) writeEasySymbol(s, r).forEach((doc, i, all) => out.push({ name: `${uniq(symNames, all.length > 1 ? `${s.name}.${i + 1}` : s.name)}.symbol.json`, data: doc }));
    for (const fp of lib.footprints) out.push({ name: `${uniq(fpNames, fp.name)}.footprint.json`, data: writeEasyFootprint(fp, r) });
  }
  return out;
}

export interface ConvertResult { input: ReadResult; outputs: OutputFile[]; writeReport: Report }

export function convert(f: InputFile, target: Format): ConvertResult[] {
  return readFile(f).map(input => {
    const writeReport = new Report();
    const outputs = writeDesign(input.design, target, writeReport);
    return { input, outputs, writeReport };
  });
}

export function zipOutputs(files: OutputFile[]): Uint8Array {
  const o: Record<string, Uint8Array> = {};
  for (const f of files) o[f.name] = typeof f.data === 'string' ? strToU8(f.data) : f.data;
  return zipSync(o, { level: 6 });
}
