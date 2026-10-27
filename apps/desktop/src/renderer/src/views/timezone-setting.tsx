/**
 * Display timezone of the workspace (PRD §5.9: "Store UTC timestamps and display dates in the
 * user's selected timezone"). Changing it changes only how dates are shown and how timeline date
 * filters are read; stored timestamps never change.
 */

import { useId, useMemo, useState } from 'react';

import { Button } from '../components/ui/button';
import { errorMessage, unwrap } from '../lib/ipc';
import { useWorkspace } from '../workspace/workspace-context';

function availableTimeZones(current: string): string[] {
  const zones = new Set(Intl.supportedValuesOf('timeZone'));
  zones.add('UTC');
  zones.add(current);
  return [...zones].sort((a, b) => a.localeCompare(b));
}

export function TimezoneSetting({ timezone }: { timezone: string }) {
  const { applyState } = useWorkspace();
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const selectId = useId();
  const zones = useMemo(() => availableTimeZones(timezone), [timezone]);
  const systemZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const save = async (next: string) => {
    if (next === timezone) return;
    setError(null);
    setSaving(true);
    try {
      applyState(await unwrap(window.mmap.workspace.setTimezone({ timezone: next })));
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-2">
      <label htmlFor={selectId} className="block text-sm font-medium">
        Timezone for dates
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <select
          id={selectId}
          className="h-9 min-w-64 rounded-md border bg-background px-2 text-sm disabled:opacity-50"
          value={timezone}
          disabled={saving}
          onChange={(event) => void save(event.target.value)}
        >
          {zones.map((zone) => (
            <option key={zone} value={zone}>
              {zone.replaceAll('_', ' ')}
            </option>
          ))}
        </select>
        {systemZone !== timezone && (
          <Button
            size="sm"
            variant="outline"
            disabled={saving}
            onClick={() => void save(systemZone)}
          >
            Use this computer’s timezone ({systemZone.replaceAll('_', ' ')})
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Dates in the timeline and elsewhere are shown in this timezone, and timeline date filters
        use its calendar days. Recorded times are stored in UTC and never change.
      </p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
