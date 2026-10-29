'use client';
import { useEffect, useState } from 'react';
import { Check, Radar, X } from 'lucide-react';
import { Panel } from '@/components/platform-ui';
import { setThreatFeed, threatFeedOn } from '@/lib/threat-words';

/**
 * The switch for the threat feed, off until you turn it on. It is kept in this browser; the console's
 * server downloads pwn.watch's list only when a page that has it on asks.
 */
export function ThreatFeedSetting() {
  const [on, setOn] = useState<boolean | null>(null);
  const [kept, setKept] = useState(true);
  useEffect(() => setOn(threatFeedOn()), []);
  const choose = (next: boolean) => {
    setKept(setThreatFeed(next));
    setOn(threatFeedOn());
  };
  return (
    <div id="threat-feed">
      <Panel title="Threat feed">
        <div className="panel-body">
          <div className="settings-grid">
            {[
              { value: false, label: 'Off', detail: 'Nothing is downloaded.', icon: X },
              {
                value: true,
                label: 'pwn.watch',
                detail: 'Incidents that match this project, on the home screen.',
                icon: Radar,
              },
            ].map(({ value, label, detail, icon: Icon }) => (
              <button
                key={label}
                className={`settings-option ${on === value ? 'is-selected' : ''}`}
                aria-pressed={on === value}
                disabled={on === null}
                onClick={() => choose(value)}
              >
                <Icon aria-hidden="true" size={23} />
                <strong>{label}</strong>
                <span>{detail}</span>
                {on === value && <Check aria-hidden="true" size={17} />}
              </button>
            ))}
          </div>
          <p className="muted">
            When on, the console’s server on this machine downloads pwn.watch’s public list of
            breaches, attacks on packages and urgent patches (about 1 MB, at most every 15 minutes
            while the home screen is open) and compares it here with the packages this project lists
            and the coding agents set up on this machine. Nothing about your project is sent;
            pwn.watch sees a download from your address. pwn.watch is run by someone else, and Stroq
            does not check what it says.
          </p>
          {!kept ? (
            <p className="muted" role="alert">
              This browser does not keep settings for this page, so the feed cannot be turned on
              here.
            </p>
          ) : null}
        </div>
      </Panel>
    </div>
  );
}
