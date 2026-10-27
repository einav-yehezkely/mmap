/**
 * Settings › Workspace: move the workspace to another folder, or delete it (PRD §5.1).
 *
 * Both actions are carried out by the main process. Moving copies and verifies every file before
 * the original goes to the Recycle Bin. Deleting requires typing the workspace name, names the
 * folder, and moves it to the Recycle Bin, so neither action destroys data irreversibly.
 */

import type { WorkspaceSummary } from '@mmap/contracts';
import { FolderInput, Trash2 } from 'lucide-react';
import { useId, useState } from 'react';

import { ConfirmDialog } from '../components/ui/alert-dialog';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { errorMessage, unwrap } from '../lib/ipc';
import { useWorkspace } from './workspace-context';

export function WorkspaceMoveDelete({ workspace }: { workspace: WorkspaceSummary }) {
  const { applyState } = useWorkspace();
  const [busy, setBusy] = useState<'moving' | 'deleting' | null>(null);
  const [message, setMessage] = useState<{ kind: 'error' | 'status'; text: string } | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [typedName, setTypedName] = useState('');
  const confirmId = useId();

  const move = async () => {
    setBusy('moving');
    setMessage(null);
    try {
      const result = await unwrap(window.mmap.workspace.move());
      if (result.cancelled) return;
      applyState(result.state);
      setMessage(
        result.originalRemoved
          ? { kind: 'status', text: 'Workspace moved. The old folder is in the Recycle Bin.' }
          : {
              kind: 'error',
              text: `Workspace moved and verified, but the old folder could not be moved to the Recycle Bin. You can delete it yourself: ${result.originalFolder ?? ''}`,
            },
      );
    } catch (error) {
      setMessage({ kind: 'error', text: errorMessage(error) });
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    setBusy('deleting');
    setMessage(null);
    try {
      const { state } = await unwrap(window.mmap.workspace.delete({ confirmName: typedName }));
      setDeleteOpen(false);
      // The workspace is closed; the app shows the workspace chooser.
      applyState(state);
    } catch (error) {
      setDeleteOpen(false);
      setMessage({ kind: 'error', text: errorMessage(error) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-3 rounded-md border p-4">
      <div className="space-y-1">
        <Button variant="outline" disabled={busy !== null} onClick={() => void move()}>
          <FolderInput aria-hidden="true" />
          {busy === 'moving' ? 'Moving… (copying and verifying files)' : 'Move workspace…'}
        </Button>
        <p className="text-xs text-muted-foreground">
          Choose a local folder. Every file is copied and verified before the old folder is moved to
          the Recycle Bin. If anything fails, the workspace stays where it is.
        </p>
      </div>

      <div className="space-y-1">
        <Button
          variant="outline"
          disabled={busy !== null}
          onClick={() => {
            setTypedName('');
            setDeleteOpen(true);
          }}
        >
          <Trash2 aria-hidden="true" />
          Delete workspace…
        </Button>
      </div>

      {message && (
        <p
          role={message.kind === 'error' ? 'alert' : 'status'}
          className={message.kind === 'error' ? 'break-all text-sm text-destructive' : 'text-sm'}
        >
          {message.text}
        </p>
      )}

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={`Delete “${workspace.name}”?`}
        confirmLabel={busy === 'deleting' ? 'Deleting…' : 'Delete workspace'}
        confirmDisabled={typedName.trim() !== workspace.name || busy !== null}
        onConfirm={() => void remove()}
      >
        <p>This folder and everything in it will be moved to the Recycle Bin:</p>
        <p className="break-all rounded-md bg-muted px-2 py-1 font-mono text-xs text-foreground">
          {workspace.folderPath}
        </p>
        <p>
          Copies of this folder you made elsewhere are not affected and still contain the data.
          Empty the Recycle Bin to remove it from this computer for good.
        </p>
        <label htmlFor={confirmId} className="block pt-2 text-foreground">
          Type <strong>{workspace.name}</strong> to confirm
        </label>
        <Input
          id={confirmId}
          value={typedName}
          onChange={(event) => setTypedName(event.target.value)}
          autoComplete="off"
        />
      </ConfirmDialog>
    </div>
  );
}
