/**
 * Render with `key={workspace.id}` so the name field resets when another workspace opens.
 *
 * Settings › Workspace: rename, show the actual folder path with an "Open folder" action
 * (PRD §5.1), warn about cloud-sync folders (ADR-0005), and switch workspaces.
 */

import type { WorkspaceSummary } from '@mmap/contracts';
import { FolderOpen } from 'lucide-react';
import { useId, useState } from 'react';
import type { FormEvent } from 'react';

import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { errorMessage, unwrap } from '../lib/ipc';
import { useWorkspace } from './workspace-context';
import { CloudSyncWarning } from './cloud-sync-warning';
import { WorkspaceSwitcher } from './workspace-switcher';

export function WorkspaceSettings({ workspace }: { workspace: WorkspaceSummary }) {
  const { applyState } = useWorkspace();
  const [name, setName] = useState(workspace.name);
  const [message, setMessage] = useState<{ kind: 'error' | 'status'; text: string } | null>(null);
  const nameId = useId();

  const rename = async (event: FormEvent) => {
    event.preventDefault();
    try {
      applyState(await unwrap(window.mmap.workspace.rename({ name })));
      setMessage({ kind: 'status', text: 'Workspace renamed.' });
    } catch (caught) {
      setMessage({ kind: 'error', text: errorMessage(caught) });
    }
  };

  const revealFolder = async () => {
    try {
      const { revealed } = await unwrap(window.mmap.workspace.revealFolder());
      if (!revealed) setMessage({ kind: 'error', text: 'The folder could not be opened.' });
    } catch (caught) {
      setMessage({ kind: 'error', text: errorMessage(caught) });
    }
  };

  return (
    <div className="space-y-6">
      <form onSubmit={(event) => void rename(event)} className="flex items-end gap-2">
        <div className="flex-1 space-y-1">
          <label htmlFor={nameId} className="text-sm">
            Workspace name
          </label>
          <Input
            id={nameId}
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <Button type="submit" variant="outline" disabled={name.trim() === workspace.name}>
          Rename
        </Button>
      </form>

      <div className="space-y-1">
        <p className="text-sm">Location</p>
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 break-all rounded-md bg-muted px-3 py-2 text-xs">
            {workspace.folderPath}
          </code>
          <Button variant="outline" onClick={() => void revealFolder()}>
            <FolderOpen aria-hidden="true" />
            Open folder
          </Button>
        </div>
        {workspace.cloudSyncProvider && <CloudSyncWarning provider={workspace.cloudSyncProvider} />}
      </div>

      {message && (
        <p
          role={message.kind === 'error' ? 'alert' : 'status'}
          className={message.kind === 'error' ? 'text-sm text-destructive' : 'text-sm'}
        >
          {message.text}
        </p>
      )}

      <details className="rounded-md border p-4">
        <summary className="cursor-pointer text-sm font-medium">Switch or create workspace</summary>
        <div className="mt-4">
          <WorkspaceSwitcher />
        </div>
      </details>
    </div>
  );
}
