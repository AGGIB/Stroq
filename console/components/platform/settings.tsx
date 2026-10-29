'use client';

import { useEffect, useState } from 'react';
import { useTheme } from 'next-themes';
import {
  ArrowRight,
  Check,
  ChevronDown,
  Info,
  Laptop,
  LoaderCircle,
  Monitor,
  Moon,
  RefreshCw,
  Sun,
} from 'lucide-react';
import { usePlatform } from '@/components/platform-provider';
import { Command, PageHeading, Panel } from '@/components/platform-ui';
import { ThreatFeedSetting } from './threat-feed-setting';

export function SettingsPage() {
  const { source, generatedAt, limitations, loading, error, connectLocal, useDemo, refresh } =
    usePlatform();
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const selectedTheme = mounted ? theme : null;
  const snapshotTime = generatedAt
    ? new Intl.DateTimeFormat('en-GB', {
        timeZone: 'UTC',
        year: 'numeric',
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).format(new Date(generatedAt))
    : null;
  return (
    <div className="page-stack">
      <PageHeading title="Workspace settings" />
      <Panel title="Data source">
        <div className="panel-body">
          <div className="settings-grid">
            <button
              className={`settings-option ${source === 'demo' ? 'is-selected' : ''}`}
              aria-pressed={source === 'demo'}
              disabled={loading}
              onClick={useDemo}
            >
              <Monitor aria-hidden="true" size={24} />
              <strong>Demo workspace</strong>
              <span>Sample activity</span>
              {source === 'demo' && <Check aria-hidden="true" size={17} />}
            </button>
            <button
              className={`settings-option ${source === 'local' ? 'is-selected' : ''}`}
              aria-pressed={source === 'local'}
              disabled={loading}
              onClick={() => void connectLocal()}
            >
              <Laptop aria-hidden="true" size={24} />
              <strong>Local machine</strong>
              <span>Connect through your private server link.</span>
              {loading ? (
                <LoaderCircle aria-hidden="true" size={17} className="spin" />
              ) : source === 'local' ? (
                <Check aria-hidden="true" size={17} />
              ) : (
                <ArrowRight aria-hidden="true" size={17} />
              )}
            </button>
          </div>
          {error && (
            <div className="info-note" role="alert">
              <Info aria-hidden="true" size={18} />
              <span>{error}</span>
            </div>
          )}
          <div className="toolbar">
            <span className="muted">
              {snapshotTime ? `Snapshot: ${snapshotTime} UTC` : 'No snapshot loaded'}
            </span>
            {source === 'local' && (
              <button
                className="button subtle small"
                disabled={loading}
                onClick={() => void refresh()}
              >
                <RefreshCw aria-hidden="true" size={14} className={loading ? 'spin' : undefined} />
                Refresh
              </button>
            )}
          </div>
        </div>
      </Panel>
      {source !== 'local' && (
        <Panel title="Connect local data">
          <div className="panel-body">
            <p className="muted">With Stroq installed, replace the workspace path:</p>
            <Command command={'stroq console --workspace "/path/to/project"'} />
            <p className="muted">
              Open the link printed in your terminal. It contains an access token; keep it private.
            </p>
            <details className="setup-next">
              <summary>Source development</summary>
              <p className="muted">From the console directory of a source checkout:</p>
              <Command command="pnpm build" />
              <Command command="pnpm serve:local" />
            </details>
          </div>
        </Panel>
      )}
      <Panel title="Appearance">
        <div className="panel-body">
          <div className="settings-grid">
            {[
              { id: 'dark', label: 'Dark', icon: Moon },
              { id: 'light', label: 'Light', icon: Sun },
              {
                id: 'system',
                label: 'System',
                icon: Monitor,
              },
            ].map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                className={`settings-option ${selectedTheme === id ? 'is-selected' : ''}`}
                aria-pressed={selectedTheme === id}
                onClick={() => setTheme(id)}
              >
                <Icon aria-hidden="true" size={23} />
                <strong>{label}</strong>
                {selectedTheme === id && <Check aria-hidden="true" size={17} />}
              </button>
            ))}
          </div>
        </div>
      </Panel>
      <ThreatFeedSetting />
      <details className="panel">
        <summary className="panel-heading">
          <h2>Data limits</h2>
          <ChevronDown aria-hidden="true" size={16} />
        </summary>
        <div className="panel-body">
          {limitations.length ? (
            <ul className="muted">
              {limitations.map((limitation) => (
                <li key={limitation}>{limitation}</li>
              ))}
            </ul>
          ) : (
            <p className="muted">
              Only recorded activity is included. An empty report does not establish safety.
            </p>
          )}
        </div>
      </details>
    </div>
  );
}
