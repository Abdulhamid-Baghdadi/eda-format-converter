import { XMLParser } from 'fast-xml-parser';

export interface XNode { tag: string; attrs: Record<string, string>; children: XNode[]; text: string }

/** Parse XML into a small ordered tree (works the same in the browser and in Node). */
export function parseXml(src: string): XNode {
  const p = new XMLParser({ preserveOrder: true, ignoreAttributes: false, attributeNamePrefix: '', parseAttributeValue: false, parseTagValue: false, trimValues: false, processEntities: true, htmlEntities: true });
  const raw = p.parse(src) as Record<string, unknown>[];
  const conv = (o: Record<string, unknown>): XNode | null => {
    const tag = Object.keys(o).find(k => k !== ':@');
    if (!tag || tag === '?xml' || tag === '!DOCTYPE') return null;
    if (tag === '#text') return { tag: '#text', attrs: {}, children: [], text: String(o['#text']) };
    const kids = ((o[tag] as Record<string, unknown>[]) ?? []).map(conv).filter((x): x is XNode => !!x);
    return { tag, attrs: (o[':@'] as Record<string, string>) ?? {}, children: kids.filter(k => k.tag !== '#text'), text: kids.filter(k => k.tag === '#text').map(k => k.text).join('') };
  };
  const nodes = raw.map(conv).filter((x): x is XNode => !!x);
  const root = nodes.find(n => n.tag !== '#text');
  if (!root) throw new Error('Empty XML document');
  return root;
}

export const child = (n: XNode | undefined, tag: string) => n?.children.find(c => c.tag === tag);
export const children = (n: XNode | undefined, tag: string) => n?.children.filter(c => c.tag === tag) ?? [];
/** Path lookup: path('drawing/board/plain') */
export function path(n: XNode | undefined, p: string): XNode | undefined { for (const t of p.split('/')) n = child(n, t); return n; }

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export function el(tag: string, attrs: Record<string, string | number | undefined | null | false> = {}, kids: (string | null | undefined | false)[] = [], text?: string): string {
  const a = Object.entries(attrs).filter(([, v]) => v !== undefined && v !== null && v !== false).map(([k, v]) => ` ${k}="${esc(typeof v === 'number' ? fmt(v) : String(v))}"`).join('');
  const body = kids.filter(Boolean) as string[];
  if (!body.length && text === undefined) return `<${tag}${a}/>`;
  if (text !== undefined) return `<${tag}${a}>${esc(text)}</${tag}>`;
  return `<${tag}${a}>\n${body.join('\n')}\n</${tag}>`;
}
export const fmt = (v: number) => { const r = Math.round(v * 1e5) / 1e5; return Object.is(r, -0) ? '0' : String(r); };
