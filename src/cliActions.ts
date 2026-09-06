import type {ActionOutcome, PortwardenActions, StopSignal} from './core/actions.js';
import type {ListenerEntry} from './core/types.js';

type ListenerStopActions = Pick<PortwardenActions, 'validateListener' | 'stopListener'>;

/** Stop each displayed task (or standalone PID) once. */
export async function stopListenerMatches(
  actions: ListenerStopActions,
  rawMatches: readonly ListenerEntry[],
  signal: StopSignal,
  onOutcome?: (outcome: ActionOutcome) => void,
): Promise<ActionOutcome[]> {
  const matches = [...new Map(rawMatches.map((listener) => [listener.task?.key ?? `pid:${listener.pid}`, listener])).values()];
  await Promise.all(matches.map((listener) => actions.validateListener(listener, signal)));

  const outcomes: ActionOutcome[] = [];
  for (const listener of matches) {
    const outcome = await actions.stopListener(listener, signal);
    outcomes.push(outcome);
    onOutcome?.(outcome);
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
