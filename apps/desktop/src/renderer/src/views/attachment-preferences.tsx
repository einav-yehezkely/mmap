/**
 * Settings › Attachments: the per-file size limit (PRD §5.10: default 20 MB, configurable on
 * this computer; there is no cloud quota).
 */

import { useEffect, useId, useState } from 'react';
import type { FormEvent } from 'react';

import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { errorMessage, unwrap } from '../lib/ipc';

export function AttachmentPreferences() {
  const [saved, setSaved] = useState<number | null>(null);
  const [value, setValue] = useState('');
  const [message, setMessage] = useState<{ kind: 'error' | 'status'; text: string } | null>(null);
  const inputId = useId();

  useEffect(() => {
    let cancelled = false;
    unwrap(window.mmap.preferences.get()).then(
      (preferences) => {
        if (cancelled) return;
        setSaved(preferences.maxAttachmentMegabytes);
        setValue(String(preferences.maxAttachmentMegabytes));
      },
      (caught: unknown) => {
        if (!cancelled) setMessage({ kind: 'error', text: errorMessage(caught) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const parsed = Number(value);
  const valid = Number.isInteger(parsed) && parsed >= 1 && parsed <= 1024;

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!valid) return;
    try {
      const updated = await unwrap(
        window.mmap.preferences.update({ maxAttachmentMegabytes: parsed }),
      );
      setSaved(updated.maxAttachmentMegabytes);
      setMessage({ kind: 'status', text: 'Saved.' });
    } catch (caught) {
      setMessage({ kind: 'error', text: errorMessage(caught) });
    }
  };

  return (
    <form onSubmit={(event) => void save(event)} className="space-y-2">
      <label htmlFor={inputId} className="text-sm">
        Maximum size per attached file (MB)
      </label>
      <div className="flex items-center gap-2">
        <Input
          id={inputId}
          type="number"
          min={1}
          max={1024}
          step={1}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          aria-invalid={!valid}
          aria-describedby={`${inputId}-help`}
          className="w-32"
        />
        <Button type="submit" variant="outline" disabled={!valid || parsed === saved}>
          Save
        </Button>
      </div>
      <p id={`${inputId}-help`} className="text-xs text-muted-foreground">
        Between 1 and 1024 MB. Files are copied into the workspace folder, so large limits use disk
        space on this computer. Programs and scripts are never accepted.
      </p>
      {message && (
        <p
          role={message.kind === 'error' ? 'alert' : 'status'}
          className={message.kind === 'error' ? 'text-sm text-destructive' : 'text-sm'}
        >
          {message.text}
        </p>
      )}
    </form>
  );
}
