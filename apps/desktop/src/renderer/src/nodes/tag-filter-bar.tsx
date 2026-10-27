/**
 * Toggleable tag chips for narrowing a list to nodes that carry all selected tags (PRD §5.8).
 * Shared by the Library and Search views so both filter the same way.
 */

import { Button } from '../components/ui/button';
import { cn } from '../lib/utils';

export interface TagOption {
  readonly id: string;
  readonly label: string;
  readonly nodeCount: number;
}

export function TagFilterBar({
  options,
  selected,
  onChange,
}: {
  options: readonly TagOption[];
  selected: readonly string[];
  onChange: (selected: readonly string[]) => void;
}) {
  if (options.length === 0) return null;
  const toggle = (tagId: string) =>
    onChange(
      selected.includes(tagId) ? selected.filter((id) => id !== tagId) : [...selected, tagId],
    );

  return (
    <div role="group" aria-label="Filter by tags" className="flex flex-wrap items-center gap-1.5">
      <span className="mr-1 text-sm text-muted-foreground">Filter:</span>
      {options.map((tag) => {
        const isSelected = selected.includes(tag.id);
        return (
          <button
            key={tag.id}
            type="button"
            aria-pressed={isSelected}
            onClick={() => toggle(tag.id)}
            className={cn(
              'rounded-full border px-2.5 py-0.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              isSelected ? 'border-primary bg-primary text-primary-foreground' : 'hover:bg-accent',
            )}
          >
            <span dir="auto">{tag.label}</span>
            <span className={cn('ml-1 text-xs', !isSelected && 'text-muted-foreground')}>
              {tag.nodeCount}
            </span>
          </button>
        );
      })}
      {selected.length > 0 && (
        <Button variant="ghost" size="sm" onClick={() => onChange([])}>
          Clear filters
        </Button>
      )}
    </div>
  );
}
