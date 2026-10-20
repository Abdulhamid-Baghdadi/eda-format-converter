#!/usr/bin/env node
/** eda-convert <files...> --to kicad|eagle|easyeda [--out dir] [--report] */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { convert, type Target } from './core/index';

const args = process.argv.slice(2);
const opt = (n: string) => { const i = args.indexOf(n); if (i < 0) return undefined; const v = args[i + 1]; args.splice(i, 2); return v; };
const to = opt('--to') as Target | undefined;
const out = opt('--out') ?? '.';
const showReport = args.includes('--report') ? (args.splice(args.indexOf('--report'), 1), true) : false;

if (!to || !['kicad', 'eagle', 'easyeda'].includes(to) || !args.length) {
  console.error('usage: eda-convert <files...> --to kicad|eagle|easyeda [--out dir] [--report]');
  process.exit(2);
}
let failed = 0;
for (const file of args) {
  try {
    for (const res of convert({ name: basename(file), data: new Uint8Array(readFileSync(file)) }, to)) {
      for (const o of res.outputs) {
        const p = join(out, o.name);
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, o.data);
        console.log(`${res.input.file} (${res.input.format}) -> ${p}`);
      }
      if (showReport) console.log(res.input.report.toText() + '\n' + res.writeReport.toText());
    }
  } catch (e) {
    failed++;
    console.error(`${file}: ${(e as Error).message}`);
  }
}
process.exit(failed ? 1 : 0);
