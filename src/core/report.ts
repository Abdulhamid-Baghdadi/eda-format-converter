/** Per-file conversion report: what was converted cleanly, approximated, or skipped. */
export type Severity = 'converted' | 'approximated' | 'skipped';

export interface ReportEntry { severity: Severity; kind: string; count: number; notes: Set<string> }

export class Report {
  private entries = new Map<string, ReportEntry>();
  readonly messages: string[] = [];

  private add(severity: Severity, kind: string, note?: string, n = 1) {
    const key = severity + '|' + kind;
    let e = this.entries.get(key);
    if (!e) { e = { severity, kind, count: 0, notes: new Set() }; this.entries.set(key, e); }
    e.count += n;
    if (note && e.notes.size < 8) e.notes.add(note);
  }
  ok(kind: string, n = 1) { if (n > 0) this.add('converted', kind, undefined, n); }
  approx(kind: string, note: string, n = 1) { this.add('approximated', kind, note, n); }
  skip(kind: string, note: string, n = 1) { this.add('skipped', kind, note, n); }
  info(msg: string) { this.messages.push(msg); }

  merge(other: Report) {
    for (const e of other.list()) {
      this.add(e.severity, e.kind, undefined, e.count);
      for (const n of e.notes) this.add(e.severity, e.kind, n, 0);
    }
    this.messages.push(...other.messages);
  }

  list(): ReportEntry[] {
    const order: Severity[] = ['converted', 'approximated', 'skipped'];
    return [...this.entries.values()].sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity) || a.kind.localeCompare(b.kind));
  }
  total(sev: Severity) { return this.list().filter(e => e.severity === sev).reduce((s, e) => s + e.count, 0); }

  toText(): string {
    const lines: string[] = [];
    for (const e of this.list()) {
      lines.push(`${e.severity.padEnd(12)} ${String(e.count).padStart(5)}  ${e.kind}${e.notes.size ? ' — ' + [...e.notes].join('; ') : ''}`);
    }
    return lines.concat(this.messages.map(m => 'note: ' + m)).join('\n');
  }
}
