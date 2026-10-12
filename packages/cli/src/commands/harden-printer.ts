/**
 * Where the output of `stroq harden` goes, in the two forms it has.
 *
 * In text mode a command shows what it has to show as it goes (a plan, before it asks anyone) and
 * ends with one message: on standard output when it succeeded, on standard error, after `stroq harden:`,
 * when it did not. In `--json` mode it shows nothing as it goes and ends with one object on standard
 * output, whatever the exit code, so that a script reads the same shape in every case.
 *
 * Every string given here is already safe to print (see `PlanView`); nothing is filtered again.
 */

export type OutcomeStatus =
  | 'planned'
  | 'nothing-to-do'
  | 'refused'
  | 'needs-acknowledgement'
  | 'declined'
  | 'applied'
  | 'undone'
  | 'failed';

export interface Outcome {
  readonly status: OutcomeStatus;
  /** One or a few plain sentences. Said as they are in text mode and carried as they are in JSON. */
  readonly message: string;
  /** More to carry in JSON, as fields of the outcome. */
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface Printer {
  readonly json: boolean;
  /** Prints `text` now in text mode; in JSON mode it prints nothing. */
  show(text: string): void;
  /** Ends the command with `outcome` (and the `payload` fields beside it in JSON) and returns `code`. */
  finish(code: number, outcome: Outcome, payload?: object): number;
}

export function makePrinter(json: boolean, action: string): Printer {
  let shown = false;
  return {
    json,
    show(text) {
      if (json) return;
      shown = true;
      process.stdout.write(text);
    },
    finish(code, outcome, payload = {}) {
      if (json) {
        const { status, message, details = {} } = outcome;
        const object = {
          command: 'harden',
          action,
          ...payload,
          outcome: { status, message, ...details },
        };
        process.stdout.write(`${JSON.stringify(object)}\n`);
      } else if (outcome.message !== '') {
        if (code === 0) process.stdout.write(`${shown ? '\n' : ''}${outcome.message}\n`);
        else process.stderr.write(`stroq harden: ${outcome.message}\n`);
      }
      return code;
    },
  };
}
