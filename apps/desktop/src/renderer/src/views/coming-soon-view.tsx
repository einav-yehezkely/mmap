/** Readable empty state for views that are scheduled for a later delivery phase. */

import type { NavigationItem } from '../navigation';

export function ComingSoonView({ item }: { item: NavigationItem }) {
  const Icon = item.icon;
  return (
    <section aria-labelledby="view-title" className="mx-auto mt-16 max-w-lg text-center">
      <Icon aria-hidden="true" className="mx-auto mb-4 size-10 text-muted-foreground" />
      <h1 id="view-title" className="text-2xl font-semibold tracking-tight">
        {item.label}
      </h1>
      <p className="mt-2 text-muted-foreground">{item.description}</p>
      <p className="mt-6 text-sm text-muted-foreground">
        This area becomes available in delivery phase {item.availableInPhase}.
      </p>
    </section>
  );
}
