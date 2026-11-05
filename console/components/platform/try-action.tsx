'use client';
import { useId, useState, type FormEvent, type KeyboardEvent } from 'react';
import { CircleAlert, LoaderCircle, Play } from 'lucide-react';
import { Badge, Panel } from '@/components/platform-ui';
import { useTryAction } from './use-try-action';
import {
  TRY_KINDS,
  TRY_LIMITATIONS,
  TRY_MAX_SUBJECT,
  TRY_VERDICT_LABEL,
  tryExamples,
  trySummary,
  validTrySubject,
  type TryKind,
  type TryResult,
  type TryVerdict,
} from '@/lib/try-action';

const KIND_LABEL: Readonly<Record<TryKind, string>> = {
  command: 'Run a command',
  read: 'Read a file',
  write: 'Write a file',
  fetch: 'Fetch a page',
};
const PLACEHOLDER: Readonly<Record<TryKind, string>> = {
  command: 'git push --force origin main',
  read: '~/.ssh/id_rsa',
  write: '.git/hooks/pre-commit',
  fetch: 'https://example.invalid/page',
};
const TONE: Readonly<Record<TryVerdict, 'green' | 'orange' | 'red' | 'muted'>> = {
  allow: 'green',
  ask: 'orange',
  deny: 'red',
  unavailable: 'muted',
};
const SESSION_TITLE = {
  none: 'Clean session',
  'after-untrusted-text': 'After untrusted text',
} as const;
const SESSION_NOTE = {
  none: 'The agent has read nothing suspicious.',
  'after-untrusted-text': "The agent just read a dependency's file that hides an instruction.",
} as const;

function Verdict({ result }: { result: TryResult }) {
  const label = TRY_VERDICT_LABEL[result.verdict];
  return (
    <article className="try-verdict" aria-label={`${SESSION_TITLE[result.taint]}: ${label}`}>
      <header>
        <h3>{SESSION_TITLE[result.taint]}</h3>
        <p>{SESSION_NOTE[result.taint]}</p>
      </header>
      <div className="try-verdict-word">
        <Badge tone={TONE[result.verdict]}>{label}</Badge>
      </div>
      {result.verdict === 'unavailable' ? (
        <p className="try-reason">
          {result.taintEstablished
            ? 'The engine did not finish this one.'
            : 'The engine could not put the session in this state.'}
        </p>
      ) : result.ruleId === null ? (
        <p className="try-reason">No rule matched. The policy default applies.</p>
      ) : (
        <>
          <p className="try-rule">
            <span className="muted">Rule</span> <code>{result.ruleId}</code>
          </p>
          {result.reason ? <p className="try-reason">{result.reason}</p> : null}
        </>
      )}
      {result.signals.length > 0 ? (
        <ul className="try-signals" aria-label="What Stroq noticed">
          {result.signals.map((signal) => (
            <li key={signal}>{signal}</li>
          ))}
        </ul>
      ) : null}
    </article>
  );
}

/** What a command would get: in a clean session and after untrusted text. The top of Rules. */
export function TryAction() {
  const { outcome, busy, error, check, localAccess } = useTryAction();
  const [kind, setKind] = useState<TryKind>('command');
  const [subject, setSubject] = useState('');
  const inputId = useId();
  const ready = validTrySubject(subject);

  const run = (nextKind: TryKind, nextSubject: string) => {
    if (busy || !validTrySubject(nextSubject)) return;
    void check({ kind: nextKind, subject: nextSubject });
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    run(kind, subject);
  };
  const submitFromKeyboard = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      run(kind, subject);
    }
  };

  return (
    <section id="try" className="rules-section" aria-labelledby="try-title">
      <div className="rules-section-head">
        <h2 id="try-title">Try an action</h2>
        <p>
          See what your policy would do with an action an agent might take. Nothing is run, written
          or sent.
        </p>
      </div>
      {!localAccess ? (
        <Panel>
          <p className="panel-body control-meta">
            Not connected to Stroq on this machine. Run <code>npx @stroq/cli console</code> to open
            this page with your data. Your own policy judges the action, so this needs the engine.
          </p>
        </Panel>
      ) : (
        <>
          <Panel title="The action" subtitle="Pick a kind, type one, or start from an example.">
            <form className="try-form" onSubmit={submit}>
              <div className="filter-tabs" role="group" aria-label="Kind of action">
                {TRY_KINDS.map((value) => (
                  <button
                    key={value}
                    type="button"
                    className={kind === value ? 'is-active' : ''}
                    aria-pressed={kind === value}
                    onClick={() => setKind(value)}
                  >
                    {KIND_LABEL[value]}
                  </button>
                ))}
              </div>
              <label className="sr-only" htmlFor={inputId}>
                {KIND_LABEL[kind]}
              </label>
              <textarea
                id={inputId}
                className="try-input mono"
                rows={kind === 'command' ? 3 : 2}
                value={subject}
                maxLength={TRY_MAX_SUBJECT}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                placeholder={PLACEHOLDER[kind]}
                onChange={(e) => setSubject(e.target.value)}
                onKeyDown={submitFromKeyboard}
              />
              <div className="try-actions">
                <button className="button primary" type="submit" disabled={!ready || busy}>
                  {busy ? (
                    <LoaderCircle size={15} className="spin" aria-hidden="true" />
                  ) : (
                    <Play size={15} aria-hidden="true" />
                  )}
                  Check this action
                </button>
                <span className="muted try-hint">⌘ Enter to check</span>
              </div>
              <div className="try-examples" role="group" aria-label="Examples">
                {tryExamples().map((example) => (
                  <button
                    key={example.title}
                    type="button"
                    className="button subtle small"
                    disabled={busy}
                    onClick={() => {
                      setKind(example.kind);
                      setSubject(example.subject);
                      run(example.kind, example.subject);
                    }}
                  >
                    {example.title}
                  </button>
                ))}
              </div>
            </form>
            {error ? (
              <p className="control-error" role="alert">
                <CircleAlert size={18} aria-hidden="true" />
                {error}
                {outcome ? ' The earlier answer is still shown below.' : ''}
              </p>
            ) : null}
          </Panel>

          <div aria-live="polite" className="try-result-region">
            {outcome ? (
              <Panel
                title="What the policy decides"
                subtitle={`${KIND_LABEL[outcome.request.kind]}: ${outcome.request.subject.split('\n')[0]?.slice(0, 120) ?? ''}`}
                actions={
                  <Badge tone="muted">
                    {outcome.answer.policySource === 'file' ? 'Your policy file' : 'Default policy'}
                  </Badge>
                }
              >
                <p className={`try-summary ${trySummary(outcome.answer.results).kind}`}>
                  {trySummary(outcome.answer.results).text}
                </p>
                <p className="try-caveat">
                  A recorded decision of your policy on a made-up event. It is not a test of any
                  agent.
                </p>
                <div className="try-verdicts">
                  {outcome.answer.results.map((result) => (
                    <Verdict key={result.taint} result={result} />
                  ))}
                </div>
              </Panel>
            ) : null}
          </div>

          <details className="panel">
            <summary className="panel-heading">
              <h2>What this is, and is not</h2>
            </summary>
            <ul className="try-limits">
              {(outcome?.answer.limitations ?? TRY_LIMITATIONS).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </details>
        </>
      )}
    </section>
  );
}
