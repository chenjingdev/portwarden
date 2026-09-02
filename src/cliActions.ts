import type {ActionOutcome, PortwardenActions, StopSignal} from './core/actions.js';
import type {ListenerEntry} from './core/types.js';

type ListenerStopActions = Pick<PortwardenActions, 'validateListener' | 'stopListener'>;

/**
 * Stop each distinct listener, skipping later PIDs only after a verified group
 * stop. A PID-only fallback intentionally leaves the remaining PIDs in the
 * worklist.
 */
export async function stopListenerMatches(
  actions: ListenerStopActions,
  rawMatches: readonly ListenerEntry[],
  signal: StopSignal,
  onOutcome?: (outcome: ActionOutcome) => void,
): Promise<ActionOutcome[]> {
  const matches = [...new Map(rawMatches.map((listener) => [listener.pid, listener])).values()];
  await Promise.all(matches.map((listener) => actions.validateListener(listener, signal)));

  const outcomes: ActionOutcome[] = [];
  const stoppedGroups = new Set<number>();
  for (const listener of matches) {
    if (listener.pgid !== undefined && stoppedGroups.has(listener.pgid)) continue;
    const outcome = await actions.stopListener(listener, signal);
    outcomes.push(outcome);
    onOutcome?.(outcome);
    if (outcome.pgid !== undefined) stoppedGroups.add(outcome.pgid);
  }
  return outcomes;
}

export function formatActionOutcomes(outcomes: readonly ActionOutcome[]): {
  stdout: string;
  stderr: string;
} {
  return {
    stdout: outcomes.map(({message}) => message).join('\n'),
    stderr: outcomes
      .flatMap(({warning}) => warning ? [`Warning: ${warning}`] : [])
      .join('\n'),
  };
}
