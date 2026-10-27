/**
 * Create, open and switch workspaces. Used both by the setup screen (no workspace open) and by
 * Settings › Workspace.
 */

import type { RecentWorkspace } from '@mmap/contracts';
import { FolderOpen, FolderPlus, X } from 'lucide-react';
import { useCallback, useEffect, useId, useState } from 'react';
import type { FormEvent } from 'react';

import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { errorMessage, unwrap } from '../lib/ipc';
import { useWorkspace } from './workspace-context';

export function WorkspaceSwitcher() {
  const { applyState } = useWorkspace();
  const [recent, setRecent] = useState<readonly RecentWorkspace[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadRecent = useCallback(async () => {
    setRecent((await unwrap(window.mmap.workspace.listRecent())).items);
  }, []);

  useEffect(() => {
    let cancelled = false;
    unwrap(window.mmap.workspace.listRecent()).then(
      ({ items }) => {
        if (!cancelled) setRecent(items);
      },
      (caught: unknown) => {
        if (!cancelled) setError(errorMessage(caught));
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  /** Runs one action at a time and shows its error in place (PRD §6: actionable errors). */
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      await loadRecent();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      {error && (
        <p
          role="alert"
          className="rounded-md border border-destructive px-3 py-2 text-sm text-destructive"
        >
          {error}
        </p>
      )}

      <CreateWorkspaceForm
        disabled={busy}
        onCreate={(name, location) =>
          run(async () => {
            const result = await unwrap(window.mmap.workspace.create({ name, location }));
            if (!result.cancelled) applyState(result.state);
          })
        }
      />

      <div>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const result = await unwrap(window.mmap.workspace.openFolder());
              if (!result.cancelled) applyState(result.state);
            })
          }
        >
          <FolderOpen aria-hidden="true" />
          Open existing workspace folder…
        </Button>
      </div>

      {recent.length > 0 && (
        <section aria-labelledby="recent-workspaces-title">
          <h3 id="recent-workspaces-title" className="mb-2 text-sm font-medium">
            Recent workspaces
          </h3>
          <ul className="divide-y rounded-md border">
            {recent.map((entry) => (
              <li key={entry.workspaceId} className="flex items-center gap-3 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">
                    {entry.name}
                    {entry.isCurrent && (
                      <span className="ml-2 text-xs font-normal text-muted-foreground">(open)</span>
                    )}
                  </p>
                  <p className="truncate text-xs text-muted-foreground" title={entry.folderPath}>
                    {entry.folderPath}
                    {!entry.isAvailable && ' — folder not found'}
                  </p>
                </div>
                {!entry.isCurrent && (
                  <>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy || !entry.isAvailable}
                      onClick={() =>
                        void run(async () => {
                          applyState(
                            await unwrap(
                              window.mmap.workspace.openRecent({ workspaceId: entry.workspaceId }),
                            ),
                          );
                        })
                      }
                    >
                      Open
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      disabled={busy}
                      aria-label={`Remove ${entry.name} from the recent list (files are kept)`}
                      title="Remove from list (files are kept)"
                      onClick={() =>
                        void run(async () => {
                          await unwrap(
                            window.mmap.workspace.forgetRecent({ workspaceId: entry.workspaceId }),
                          );
                        })
                      }
                    >
                      <X aria-hidden="true" />
                    </Button>
                  </>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function CreateWorkspaceForm({
  disabled,
  onCreate,
}: {
  disabled: boolean;
  onCreate: (name: string, location: 'default' | 'choose-folder') => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [location, setLocation] = useState<'default' | 'choose-folder'>('default');
  const nameId = useId();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void onCreate(name, location).then(() => setName(''));
  };

  return (
    <form onSubmit={submit} className="space-y-3 rounded-md border p-4">
      <h3 className="text-sm font-medium">Create a new workspace</h3>
      <div className="space-y-1">
        <label htmlFor={nameId} className="text-sm">
          Name
        </label>
        <Input
          id={nameId}
          value={name}
          maxLength={80}
          required
          onChange={(event) => setName(event.target.value)}
          placeholder="e.g. Thesis research"
        />
      </div>
      <fieldset className="space-y-1 text-sm">
        <legend className="mb-1">Location</legend>
        <label className="flex items-center gap-2">
          <input
            type="radio"
            name="workspace-location"
            checked={location === 'default'}
            onChange={() => setLocation('default')}
          />
          Default mmap folder
        </label>
        <label className="flex items-center gap-2">
          <input
            type="radio"
            name="workspace-location"
            checked={location === 'choose-folder'}
            onChange={() => setLocation('choose-folder')}
          />
          Choose a folder on this computer…
        </label>
      </fieldset>
      <Button type="submit" disabled={disabled || name.trim().length === 0}>
        <FolderPlus aria-hidden="true" />
        Create workspace
      </Button>
    </form>
  );
}
