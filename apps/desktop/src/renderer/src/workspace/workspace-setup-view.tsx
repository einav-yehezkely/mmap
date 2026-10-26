/**
 * Full-screen view shown when no workspace is open: either nothing was opened yet, or the last
 * workspace is unavailable (missing folder, locked, damaged, too new). The cause is explained
 * and the user chooses what to do; nothing is replaced automatically (PRD §5.1).
 */

import type { WorkspaceState } from '@mmap/contracts';
import { TriangleAlert } from 'lucide-react';

import { WorkspaceSwitcher } from './workspace-switcher';

export function WorkspaceSetupView({
  state,
}: {
  state: Exclude<WorkspaceState, { status: 'open' }>;
}) {
  return (
    <main id="main-content" className="mx-auto max-w-xl px-6 py-12">
      <h1 className="text-2xl font-semibold tracking-tight">Choose a workspace</h1>
      <p className="mt-2 text-muted-foreground">
        A workspace is a folder on this computer that holds your notes, maps and files.
      </p>

      {state.status === 'unavailable' && (
        <div role="alert" className="mt-6 flex gap-3 rounded-md border border-destructive p-4">
          <TriangleAlert aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-destructive" />
          <div className="min-w-0 text-sm">
            <p className="font-medium">
              {state.lastWorkspace
                ? `“${state.lastWorkspace.name}” could not be opened.`
                : 'The workspace could not be opened.'}
            </p>
            <p className="mt-1">{state.message}</p>
            {state.lastWorkspace && (
              <p className="mt-1 break-all text-muted-foreground">
                {state.lastWorkspace.folderPath}
              </p>
            )}
            <p className="mt-2 text-muted-foreground">
              Nothing was deleted or replaced. If the folder is on a removable drive, reconnect it
              and open it again below.
            </p>
          </div>
        </div>
      )}

      <div className="mt-8">
        <WorkspaceSwitcher />
      </div>
    </main>
  );
}
