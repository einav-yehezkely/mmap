/**
 * Toggleable relationship-type chips for narrowing search results to nodes with at least one
 * relationship of any selected type (PRD §5.8: "relationship-type filters where applicable").
 * Only types in use are offered (plus any still selected), so every chip can match something.
 * Directed types show an arrow and undirected ones a dash, as everywhere else.
 */

import type { RelationshipTypeViewDto } from '@mmap/contracts';

import { Button } from '../components/ui/button';
import { cn } from '../lib/utils';

export function RelationshipTypeFilterBar({
  types,
  selected,
  onChange,
}: {
  types: readonly RelationshipTypeViewDto[];
  selected: readonly string[];
  onChange: (selected: readonly string[]) => void;
}) {
  const offered = types.filter((type) => type.usageCount > 0 || selected.includes(type.id));
  if (offered.length === 0) return null;
  const toggle = (typeId: string) =>
    onChange(
      selected.includes(typeId) ? selected.filter((id) => id !== typeId) : [...selected, typeId],
    );

  return (
    <div
      role="group"
      aria-label="Filter by relationship type"
      className="flex flex-wrap items-center gap-1.5"
    >
      <span className="mr-1 text-sm text-muted-foreground">Has a relationship:</span>
      {offered.map((type) => {
        const isSelected = selected.includes(type.id);
        return (
          <button
            key={type.id}
            type="button"
            aria-pressed={isSelected}
            onClick={() => toggle(type.id)}
            className={cn(
              'rounded-full border px-2.5 py-0.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              isSelected ? 'border-primary bg-primary text-primary-foreground' : 'hover:bg-accent',
            )}
          >
            <span dir="auto">{type.label}</span>
            <span aria-hidden="true">{type.directionality === 'directed' ? ' →' : ' —'}</span>
            <span className={cn('ml-1 text-xs', !isSelected && 'text-muted-foreground')}>
              {type.usageCount}
            </span>
          </button>
        );
      })}
      {selected.length > 0 && (
        <Button variant="ghost" size="sm" onClick={() => onChange([])}>
          Clear
        </Button>
      )}
    </div>
  );
}
