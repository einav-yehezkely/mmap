/**
 * Last-resort handler for rendering errors (PRD §6: actionable errors, never a blank window).
 *
 * Saved data is not at risk: every write is committed by the main process before the UI reports
 * it as saved, so reloading the window only discards the in-memory view. Error details are not
 * shown because they may contain note content; they go to the developer console only.
 */

import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

import { Button } from './ui/button';

interface ErrorBoundaryState {
  readonly failed: boolean;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  public override state: ErrorBoundaryState = { failed: false };

  public static getDerivedStateFromError(): ErrorBoundaryState {
    return { failed: true };
  }

  public override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Rendering failed', error, info.componentStack);
  }

  public override render(): ReactNode {
    if (!this.state.failed) {
      return this.props.children;
    }
    return (
      <main role="alert" className="mx-auto max-w-lg px-6 py-16 text-center">
        <h1 className="text-xl font-semibold">Something went wrong in this window</h1>
        <p className="mt-2 text-muted-foreground">
          Your saved work is safe. Reload the window to continue.
        </p>
        <Button className="mt-6" onClick={() => window.location.reload()}>
          Reload window
        </Button>
      </main>
    );
  }
}
