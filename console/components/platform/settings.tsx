'use client';

import { useEffect, useState } from 'react';
import { useTheme } from 'next-themes';
import { Check, Monitor, Moon, Sun } from 'lucide-react';
import { PageHeading, Panel } from '@/components/platform-ui';

const THEMES = [
  { id: 'dark', label: 'Dark', icon: Moon },
  { id: 'light', label: 'Light', icon: Sun },
  { id: 'system', label: 'System', icon: Monitor },
] as const;

/** The console's one setting: how it looks. */
export function SettingsPage() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const selectedTheme = mounted ? theme : null;
  return (
    <div className="page-stack">
      <PageHeading title="Settings" />
      <Panel title="Appearance">
        <div className="panel-body">
          <div className="settings-grid">
            {THEMES.map(({ id, label, icon: Icon }) => (
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
    </div>
  );
}
