import './style.css';
import { readFile, writeDesign, zipOutputs, type Format, type ConvertResult, type ReadResult } from '../core/index';
import type { Design, Library, OutputFile } from '../core/model';
import { Report } from '../core/report';
import { LAYER_GROUPS, renderBoard, renderFootprint, renderSymbol, type LayerGroup, type View } from './render';
import { MATRIX, FORMAT_NOTES } from './matrix';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const LABEL: Record<Format, string> = { kicad: 'KiCad', eagle: 'Eagle', easyeda: 'EasyEDA' };

interface Entry { name: string; results?: (ConvertResult & { back: Design[] })[]; error?: string; data: Uint8Array }
const state = {
  target: 'kicad' as Format,
  entries: [] as Entry[],
  sel: { entry: 0, result: 0, item: 0, unit: 0 },
  hidden: new Set<LayerGroup>(['CrtYd', 'Mask', 'B.Fab', 'F.Fab']),
};

const SAMPLES: { file: string; label: string; from: Format; kind: string }[] = [
  { file: 'blinky-555.brd', label: '555 blinker board', from: 'eagle', kind: 'Eagle board' },
  { file: 'blinky-555.kicad_pcb', label: '555 blinker board', from: 'kicad', kind: 'KiCad board' },
  { file: 'blinky-555.json', label: '555 blinker board', from: 'easyeda', kind: 'EasyEDA PCB' },
  { file: 'demo-parts.lbr', label: 'Eagle library', from: 'eagle', kind: 'symbols + packages' },
  { file: 'SOT-23-5_regulator.json', label: 'EasyEDA part', from: 'easyeda', kind: 'symbol + footprint' },
  { file: 'demo-parts.zip', label: 'KiCad library', from: 'kicad', kind: '.kicad_sym + .pretty' },
];

// ------------------------------------------------------------------ conversion
function libOf(designs: Design[]): Library {
  return { symbols: designs.flatMap(d => (d.kind === 'library' ? d.library.symbols : [])), footprints: designs.flatMap(d => (d.kind === 'library' ? d.library.footprints : [])) };
}
function convertEntry(e: Entry) {
  try {
    const inputs: ReadResult[] = readFile({ name: e.name, data: e.data });
    e.results = inputs.map(input => {
      const writeReport = new Report();
      const outputs = writeDesign(input.design, state.target, writeReport);
      const back = outputs.flatMap(o => { try { return readFile({ name: o.name, data: o.data }).map(r => r.design); } catch { return []; } });
      return { input, outputs, writeReport, back };
    });
    e.error = undefined;
  } catch (err) {
    e.results = undefined;
    e.error = (err as Error).message;
    console.error(err);
  }
}

async function addFiles(files: { name: string; data: Uint8Array }[]) {
  for (const f of files) {
    const e: Entry = { name: f.name, data: f.data };
    convertEntry(e);
    state.entries.push(e);
  }
  state.sel = { entry: state.entries.length - files.length, result: 0, item: 0, unit: 0 };
  render();
}

// ------------------------------------------------------------------ items
interface Item { kind: 'symbol' | 'footprint' | 'board'; name: string; src: View | null; dst: View | null; units: number }
function items(r: ConvertResult & { back: Design[] }): { label: string; kind: Item['kind']; idx: number }[] {
  const d = r.input.design;
  if (d.kind === 'board') return [{ label: d.name, kind: 'board', idx: 0 }];
  return [...d.library.symbols.map((s, i) => ({ label: s.name, kind: 'symbol' as const, idx: i })), ...d.library.footprints.map((f, i) => ({ label: f.name, kind: 'footprint' as const, idx: i }))];
}
const show = (g: LayerGroup) => !state.hidden.has(g);

function views(r: ConvertResult & { back: Design[] }, it: { kind: Item['kind']; idx: number }, unit: number): { src: View | null; dst: View | null; units: number } {
  const d = r.input.design;
  if (it.kind === 'board') {
    const back = r.back.find(b => b.kind === 'board');
    return { src: d.kind === 'board' ? renderBoard(d.board, show) : null, dst: back?.kind === 'board' ? renderBoard(back.board, show) : null, units: 1 };
  }
  const lib = libOf(r.back);
  if (d.kind !== 'library') return { src: null, dst: null, units: 1 };
  if (it.kind === 'footprint') {
    const fp = d.library.footprints[it.idx];
    const out = lib.footprints[it.idx];
    return { src: renderFootprint(fp, show), dst: out ? renderFootprint(out, show) : null, units: 1 };
  }
  const s = d.library.symbols[it.idx];
  // EasyEDA writes one symbol per unit; find the matching written unit
  let out = lib.symbols[it.idx], outUnit = unit;
  if (state.target === 'easyeda' && s.units.length > 1) {
    const offset = d.library.symbols.slice(0, it.idx).reduce((n, x) => n + x.units.length, 0);
    out = lib.symbols[offset + unit]; outUnit = 0;
  } else if (state.target === 'easyeda') {
    const offset = d.library.symbols.slice(0, it.idx).reduce((n, x) => n + x.units.length, 0);
    out = lib.symbols[offset];
  }
  return { src: renderSymbol(s, unit), dst: out ? renderSymbol(out, outUnit) : null, units: s.units.length };
}

// ------------------------------------------------------------------ pan / zoom (both panes share one view box)
let vb = { x: 0, y: 0, w: 10, h: 10 };
let fitBox = vb;
let lastBox: View['box'] | null = null;
function applyVb() {
  for (const id of ['srcSvg', 'dstSvg']) $(id).setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
}
function fit(box: View['box']) {
  lastBox = box;
  const rect = $('srcSvg').getBoundingClientRect();
  // the SVG letterboxes anyway; matching its aspect ratio keeps pan/zoom maths exact
  const ar = rect.width > 10 && rect.height > 10 ? rect.width / rect.height : box.w / box.h;
  let { x, y, w, h } = box;
  if (w / h < ar) { const nw = h * ar; x -= (nw - w) / 2; w = nw; } else { const nh = w / ar; y -= (nh - h) / 2; h = nh; }
  vb = { x, y, w, h }; fitBox = vb; applyVb();
}
function setupPanZoom(svg: SVGSVGElement) {
  svg.addEventListener('wheel', ev => {
    ev.preventDefault();
    const r = svg.getBoundingClientRect();
    const k = Math.exp(ev.deltaY * 0.0015);
    const px = vb.x + ((ev.clientX - r.left) / r.width) * vb.w, py = vb.y + ((ev.clientY - r.top) / r.height) * vb.h;
    vb = { x: px - (px - vb.x) * k, y: py - (py - vb.y) * k, w: vb.w * k, h: vb.h * k };
    applyVb();
  }, { passive: false });
  let drag: { x: number; y: number; vb: typeof vb } | null = null;
  svg.addEventListener('pointerdown', ev => { drag = { x: ev.clientX, y: ev.clientY, vb: { ...vb } }; svg.setPointerCapture(ev.pointerId); svg.classList.add('grab'); });
  svg.addEventListener('pointermove', ev => {
    if (!drag) return;
    const r = svg.getBoundingClientRect();
    vb = { ...drag.vb, x: drag.vb.x - ((ev.clientX - drag.x) / r.width) * vb.w, y: drag.vb.y - ((ev.clientY - drag.y) / r.height) * vb.h };
    applyVb();
  });
  const end = () => { drag = null; svg.classList.remove('grab'); };
  svg.addEventListener('pointerup', end); svg.addEventListener('pointercancel', end);
  svg.addEventListener('dblclick', () => { vb = fitBox; applyVb(); });
}

// ------------------------------------------------------------------ rendering
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function render(keepView = false) {
  const has = state.entries.length > 0;
  $('empty').hidden = has;
  $('workspace').hidden = !has;
  if (!has) return;
  // file list
  $('fileList').innerHTML = state.entries.map((e, i) => {
    const rs = e.results ?? [];
    const kinds = rs.map(r => r.input.design.kind === 'board' ? 'board' : `${r.input.design.library.symbols.length} sym · ${r.input.design.library.footprints.length} fp`).join(', ');
    const fmt = rs[0]?.input.format;
    const issues = rs.reduce((n, r) => n + r.input.report.total('skipped') + r.writeReport.total('skipped'), 0);
    const approx = rs.reduce((n, r) => n + r.input.report.total('approximated') + r.writeReport.total('approximated'), 0);
    return `<li class="${i === state.sel.entry ? 'sel' : ''} ${e.error ? 'err' : ''}" data-i="${i}">
      <div class="fname" title="${esc(e.name)}">${esc(e.name)}</div>
      <div class="fmeta">${e.error ? `<span class="pill bad">not converted</span>` : `<span class="badge ${fmt}">${LABEL[fmt!]}</span> → <span class="badge ${state.target}">${LABEL[state.target]}</span> <span class="muted">${kinds}</span>`}</div>
      ${e.error ? `<div class="ferr">${esc(e.error)}</div>` : `<div class="fstat"><span class="dot ok"></span>converted ${approx ? `<span class="dot warn"></span>${approx} approx.` : ''} ${issues ? `<span class="dot bad"></span>${issues} skipped` : ''}</div>`}
    </li>`;
  }).join('');
  const e = state.entries[state.sel.entry];
  const r = e?.results?.[state.sel.result];
  if (!r) {
    $('itemBar').innerHTML = e?.error ? `<div class="errbox"><strong>${esc(e.name)}</strong><br>${esc(e.error)}</div>` : '';
    $('outputs').innerHTML = '';
    for (const id of ['srcSvg', 'dstSvg']) $(id).innerHTML = '';
    $('summary').innerHTML = ''; (document.querySelector('#reportTable tbody') as HTMLElement).innerHTML = '';
    return;
  }
  const its = items(r);
  const it = its[Math.min(state.sel.item, its.length - 1)];
  // item selector
  const resultTabs = (e.results!.length > 1) ? `<select id="resultSel">${e.results!.map((x, i) => `<option value="${i}" ${i === state.sel.result ? 'selected' : ''}>${esc(x.input.file)}</option>`).join('')}</select>` : '';
  $('itemBar').innerHTML = resultTabs + (its.length > 1
    ? `<select id="itemSel" aria-label="Item">${its.map((x, i) => `<option value="${i}" ${i === state.sel.item ? 'selected' : ''}>${x.kind === 'symbol' ? '⏚ symbol' : '▣ footprint'} · ${esc(x.label)}</option>`).join('')}</select><span class="muted small">${its.length} items</span>`
    : `<strong>${esc(it.label)}</strong> <span class="muted small">${it.kind}</span>`);
  // outputs
  const btn = (o: OutputFile, i: number) => `<button class="ghost small dlbtn" data-o="${i}" title="Download ${esc(o.name)}">⭳ ${esc(o.name.split('/').pop()!)}</button>`;
  $('outputs').innerHTML = r.outputs.length <= 3 ? r.outputs.map(btn).join('')
    : `<details class="outlist"><summary class="ghost small">⭳ ${r.outputs.length} output files</summary><div class="outmenu">${r.outputs.map(btn).join('')}</div></details>`;
  // previews
  const v = views(r, it, state.sel.unit);
  for (const id of ['srcSvg', 'dstSvg']) $(id).classList.toggle('paper', it.kind === 'symbol');
  $('srcSvg').innerHTML = v.src?.svg ?? '';
  $('dstSvg').innerHTML = v.dst?.svg ?? '<text x="0" y="0" font-size="1" fill="currentColor">no preview</text>';
  $('srcBadge').textContent = LABEL[r.input.format]; $('srcBadge').className = `badge ${r.input.format}`;
  $('dstBadge').textContent = LABEL[state.target]; $('dstBadge').className = `badge ${state.target}`;
  if (!keepView && v.src) requestAnimationFrame(() => fit(v.src!.box)); else applyVb();
  // units
  const multi = v.units > 1;
  $('unitPrev').hidden = $('unitNext').hidden = !multi;
  $('unitLabel').textContent = multi ? `unit ${String.fromCharCode(65 + state.sel.unit)} of ${v.units}` : '';
  // layers (not for symbols)
  $('layers').innerHTML = it.kind === 'symbol' ? '<span class="muted small">Symbol view · scroll to zoom, drag to pan</span>' : LAYER_GROUPS.map(g => `<label class="lyr"><input type="checkbox" data-l="${g.id}" ${state.hidden.has(g.id) ? '' : 'checked'}><span class="sw" style="background:${g.color}"></span>${g.label}</label>`).join('');
  // report
  const rep = new Report(); rep.merge(r.input.report); rep.merge(r.writeReport);
  const c = rep.total('converted'), a = rep.total('approximated'), s = rep.total('skipped');
  $('summary').innerHTML = `<span class="stat ok"><b>${c}</b> converted</span><span class="stat warn"><b>${a}</b> approximated</span><span class="stat bad"><b>${s}</b> skipped</span>` + rep.messages.map(m => `<p class="note">ℹ️ ${esc(m)}</p>`).join('');
  (document.querySelector('#reportTable tbody') as HTMLElement).innerHTML = rep.list().filter(x => x.count > 0).map(x => `<tr class="${x.severity}"><td><span class="pill ${x.severity === 'converted' ? 'ok' : x.severity === 'approximated' ? 'warn' : 'bad'}">${x.severity}</span></td><td>${esc(x.kind)}</td><td class="num">${x.count}</td><td class="muted">${esc([...x.notes].join(' · '))}</td></tr>`).join('');
}

function download(name: string, data: string | Uint8Array, type = 'application/octet-stream') {
  const blob = new Blob([data as BlobPart], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

function allOutputs(): OutputFile[] {
  const out: OutputFile[] = [];
  const used = new Set<string>();
  for (const e of state.entries) for (const r of e.results ?? []) for (const o of r.outputs) {
    let n = o.name; let k = 2;
    while (used.has(n)) n = o.name.replace(/(\.[^./]+(\.json)?)$/, `_${k++}$1`);
    used.add(n); out.push({ ...o, name: n });
  }
  return out;
}

// ------------------------------------------------------------------ wiring
async function readDropped(list: FileList | File[]) {
  const files = await Promise.all([...list].map(async f => ({ name: f.name, data: new Uint8Array(await f.arrayBuffer()) })));
  await addFiles(files);
}

function init() {
  const drop = $('drop');
  const input = $<HTMLInputElement>('fileInput');
  input.addEventListener('change', () => { if (input.files?.length) readDropped(input.files); input.value = ''; });
  drop.addEventListener('keydown', ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); input.click(); } });
  for (const t of [document.body]) {
    t.addEventListener('dragover', ev => { ev.preventDefault(); drop.classList.add('over'); });
    t.addEventListener('dragleave', ev => { if (ev.target === document.body || !(ev.relatedTarget as Node | null)) drop.classList.remove('over'); });
    t.addEventListener('drop', ev => { ev.preventDefault(); drop.classList.remove('over'); if (ev.dataTransfer?.files.length) readDropped(ev.dataTransfer.files); });
  }
  $('samples').innerHTML = SAMPLES.map(s => `<button class="sample" data-f="${s.file}"><span class="badge ${s.from}">${LABEL[s.from]}</span><strong>${s.label}</strong><span class="muted small">${s.kind} · ${s.file}</span></button>`).join('');
  $('samples').addEventListener('click', async ev => {
    const b = (ev.target as HTMLElement).closest('button.sample') as HTMLElement | null;
    if (!b) return;
    const f = b.dataset.f!;
    const res = await fetch(`samples/${f}`);
    await addFiles([{ name: f, data: new Uint8Array(await res.arrayBuffer()) }]);
  });
  $('targetSeg').addEventListener('click', ev => {
    const b = (ev.target as HTMLElement).closest('button') as HTMLElement | null;
    if (!b) return;
    state.target = b.dataset.t as Format;
    for (const x of $('targetSeg').querySelectorAll('button')) x.setAttribute('aria-checked', String(x === b));
    $('targetHint').textContent = FORMAT_NOTES[state.target];
    for (const e of state.entries) convertEntry(e);
    render(true);
  });
  $('fileList').addEventListener('click', ev => {
    const li = (ev.target as HTMLElement).closest('li') as HTMLElement | null;
    if (!li) return;
    state.sel = { entry: +li.dataset.i!, result: 0, item: 0, unit: 0 };
    render();
  });
  document.addEventListener('change', ev => {
    const t = ev.target as HTMLElement;
    if (t.id === 'itemSel') { state.sel.item = +(t as HTMLSelectElement).value; state.sel.unit = 0; render(); }
    if (t.id === 'resultSel') { state.sel.result = +(t as HTMLSelectElement).value; state.sel.item = 0; state.sel.unit = 0; render(); }
    if (t.matches('#layers input')) { const l = (t as HTMLInputElement).dataset.l as LayerGroup; if ((t as HTMLInputElement).checked) state.hidden.delete(l); else state.hidden.add(l); render(true); }
  });
  $('outputs').addEventListener('click', ev => {
    const b = (ev.target as HTMLElement).closest('button') as HTMLElement | null;
    const r = state.entries[state.sel.entry]?.results?.[state.sel.result];
    if (!b || !r) return;
    const o = r.outputs[+b.dataset.o!];
    download(o.name.split('/').pop()!, o.data);
  });
  $('zipBtn').addEventListener('click', () => {
    const outs = allOutputs();
    if (!outs.length) return;
    if (outs.length === 1) download(outs[0].name.split('/').pop()!, outs[0].data);
    else download(`converted-${state.target}.zip`, zipOutputs(outs), 'application/zip');
  });
  $('clearBtn').addEventListener('click', () => { state.entries = []; render(); });
  $('fitBtn').addEventListener('click', () => { if (lastBox) fit(lastBox); });
  $('unitPrev').addEventListener('click', () => { state.sel.unit = Math.max(0, state.sel.unit - 1); render(true); });
  $('unitNext').addEventListener('click', () => { state.sel.unit++; const e = state.entries[state.sel.entry]; const r = e.results![state.sel.result]; const it = items(r)[state.sel.item]; const n = r.input.design.kind === 'library' && it.kind === 'symbol' ? r.input.design.library.symbols[it.idx].units.length : 1; state.sel.unit = Math.min(n - 1, state.sel.unit); render(true); });
  for (const id of ['srcSvg', 'dstSvg']) setupPanZoom($(id) as unknown as SVGSVGElement);
  $('themeBtn').addEventListener('click', () => {
    const cur = document.documentElement.dataset.theme ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('theme', next); } catch { /* private mode */ }
  });
  $('matrixBody').innerHTML = `<p class="muted">Any reader pairs with any writer through one neutral model. Rows describe what each format can <em>hold</em>: ✅ exact · ⚠️ approximated (listed in the report) · ❌ dropped.</p>
    <table class="matrix"><thead><tr><th></th><th>KiCad</th><th>Eagle</th><th>EasyEDA Std</th></tr></thead><tbody>${MATRIX.map(m => `<tr><td>${m.item}</td><td>${m.kicad}</td><td>${m.eagle}</td><td>${m.easyeda}</td></tr>`).join('')}</tbody></table>`;
  $('matrixBtn').addEventListener('click', () => ($('matrix') as HTMLDialogElement).showModal());
  window.addEventListener('resize', () => { if (state.entries.length && lastBox) fit(lastBox); });
  render();
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
  // deep link: ?sample=blinky-555.brd&to=kicad
  const q = new URLSearchParams(location.search);
  const to = q.get('to') as Format | null;
  if (to && LABEL[to]) (document.querySelector(`#targetSeg button[data-t="${to}"]`) as HTMLElement)?.click();
  const sample = q.get('sample');
  if (sample) (document.querySelector(`button.sample[data-f="${CSS.escape(sample)}"]`) as HTMLElement)?.click();
}
init();
