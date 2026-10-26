/**
 * Confirmation dialog for destructive actions (PRD §6), following the shadcn/ui source pattern on
 * top of Radix AlertDialog, which provides focus trapping, Escape-to-cancel and screen-reader
 * semantics. The cancel button receives initial focus, so pressing Enter never confirms a
 * destructive action by accident.
 */

import { AlertDialog as Primitive } from 'radix-ui';
import type { ReactNode } from 'react';

import { Button } from './button';

export interface ConfirmDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  readonly children: ReactNode;
  readonly confirmLabel: string;
  readonly onConfirm: () => void;
  readonly confirmDisabled?: boolean;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  children,
  confirmLabel,
  onConfirm,
  confirmDisabled = false,
}: ConfirmDialogProps) {
  return (
    <Primitive.Root open={open} onOpenChange={onOpenChange}>
      <Primitive.Portal>
        <Primitive.Overlay className="fixed inset-0 bg-black/50" />
        <Primitive.Content className="fixed left-1/2 top-1/2 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-md border bg-background p-6 shadow-lg focus:outline-none">
          <Primitive.Title className="text-lg font-semibold">{title}</Primitive.Title>
          <Primitive.Description asChild>
            <div className="mt-2 space-y-2 text-sm text-muted-foreground">{children}</div>
          </Primitive.Description>
          <div className="mt-6 flex justify-end gap-2">
            <Primitive.Cancel asChild>
              <Button variant="outline">Cancel</Button>
            </Primitive.Cancel>
            <Primitive.Action asChild>
              <Button variant="destructive" disabled={confirmDisabled} onClick={onConfirm}>
                {confirmLabel}
              </Button>
            </Primitive.Action>
          </div>
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}
