/**
 * Warning for workspaces that appear to be inside a cloud-sync folder (ADR-0005). Shown in
 * Settings and as a banner as soon as such a workspace is open, so the user learns about the risk
 * when creating or opening it, not only when visiting Settings.
 */

export function CloudSyncWarning({ provider }: { provider: string }) {
  return (
    <p role="note" className="text-sm text-destructive">
      This workspace appears to be in a folder synced by {provider}. Live sync can damage an open
      database. Use “Move workspace” in Settings to move it to a local folder that is not synced.
    </p>
  );
}
