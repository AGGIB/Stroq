'use client';

import { Monitor, Moon, Sun } from 'lucide-react';
import { useTheme } from 'next-themes';
import { useSyncExternalStore } from 'react';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';

const OPTIONS = [
  { value: 'system', label: 'Follow the system', icon: Monitor },
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
] as const;

const noop = () => () => {};

/** System, light or dark. The choice is known only in the browser, so nothing is pressed until then. */
export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const mounted = useSyncExternalStore(
    noop,
    () => true,
    () => false,
  );
  return (
    <ToggleGroup
      type="single"
      value={mounted ? (theme ?? 'system') : ''}
      onValueChange={(value) => {
        if (value !== '') setTheme(value);
      }}
      aria-label="Theme"
      className="w-fit gap-0.5 rounded-md border border-sidebar-border bg-background p-0.5"
    >
      {OPTIONS.map((option) => (
        <ToggleGroupItem
          key={option.value}
          value={option.value}
          aria-label={option.label}
          title={option.label}
          className="h-6 w-[26px] min-w-0 rounded-[4px] px-0 text-ink-3 data-[state=on]:text-foreground"
        >
          <option.icon aria-hidden="true" className="size-3.5" />
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
