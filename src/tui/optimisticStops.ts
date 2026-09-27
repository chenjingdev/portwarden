import type {VisibleRow} from './rows.js';

export interface StopPresentation {
  id: number;
  identities: string[];
  phase: 'pending' | 'stopped' | 'failed';
  error?: string;
}

export function processIdentity(process: {pid: number; startTime?: Date}): string {
  return `${process.pid}:${process.startTime?.getTime() ?? ''}`;
}

export function rowIdentities(row: VisibleRow): string[] {
  if (row.type === 'browser') return row.browser.members.map(processIdentity);
  if (row.type === 'zombie') return [processIdentity(row.zombie)];
  const listeners = row.type === 'listener' ? [row.listener] : row.members;
  return listeners.flatMap((entry) => (entry.task?.members ?? [entry]).map(processIdentity));
}

/** Move complete row blocks so expanded children stay attached to their parent. */
export function failedRowsLast(rows: VisibleRow[], failed: ReadonlySet<string>): VisibleRow[] {
  const blocks: VisibleRow[][] = [];
  for (const row of rows) {
    if (row.type === 'listener' && row.parentGroupKey && blocks.at(-1)?.[0]?.key === row.parentGroupKey) {
      blocks.at(-1)!.push(row);
    } else {
      blocks.push([row]);
    }
  }
  const isFailed = (block: VisibleRow[]) => rowIdentities(block[0]!).some((id) => failed.has(id));
  return [...blocks.filter((block) => !isFailed(block)), ...blocks.filter(isFailed)].flat();
}
