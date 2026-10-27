/**
 * Modal form dialog following the shadcn/ui source pattern on top of Radix Dialog (focus trap,
 * Escape to close, labelled title and description for screen readers).
 */

import { Dialog as Primitive } from 'radix-ui';
import type { FormEvent, ReactNode } from 'react';

import { Button } from './button';

export interface FormDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  readonly description?: string;
  readonly submitLabel: string;
  readonly onSubmit: () => void;
  readonly submitDisabled?: boolean;
  /** Optional extra action shown on the left, e.g. "Remove link". */
  readonly secondaryAction?: { readonly label: string; readonly onClick: () => void };
  readonly children: ReactNode;
}

export function FormDialog({
  open,
  onOpenChange,
  title,
  description,
  submitLabel,
  onSubmit,
  submitDisabled = false,
  secondaryAction,
  children,
}: FormDialogProps) {
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!submitDisabled) onSubmit();
  };

  return (
    <Primitive.Root open={open} onOpenChange={onOpenChange}>
      <Primitive.Portal>
        <Primitive.Overlay className="fixed inset-0 bg-black/50" />
        <Primitive.Content className="fixed left-1/2 top-1/2 w-full max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-md border bg-background p-6 shadow-lg focus:outline-none">
          <Primitive.Title className="text-lg font-semibold">{title}</Primitive.Title>
          {description ? (
            <Primitive.Description className="mt-1 text-sm text-muted-foreground">
              {description}
            </Primitive.Description>
          ) : (
            <Primitive.Description className="sr-only">{title}</Primitive.Description>
          )}
          <form onSubmit={submit} className="mt-4 space-y-4">
            {children}
            <div className="flex items-center gap-2">
              {secondaryAction && (
                <Button type="button" variant="ghost" onClick={secondaryAction.onClick}>
                  {secondaryAction.label}
                </Button>
              )}
              <div className="ml-auto flex gap-2">
                <Primitive.Close asChild>
                  <Button type="button" variant="outline">
                    Cancel
                  </Button>
                </Primitive.Close>
                <Button type="submit" disabled={submitDisabled}>
                  {submitLabel}
                </Button>
              </div>
            </div>
          </form>
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}
