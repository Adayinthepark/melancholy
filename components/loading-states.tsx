import { Skeleton } from "./ui/skeleton";
import { Mark } from "./brand";
import { Button } from "./ui/button";

export function SettingsSkeleton({
  kind = "list",
}: {
  kind?: "list" | "form" | "usage";
}) {
  return (
    <div
      className="settings-skeleton"
      role="status"
      aria-label="Loading settings"
    >
      <span className="sr-only">Loading settings</span>
      <div aria-hidden="true">
        {kind === "usage" && (
          <div className="usage-totals">
            {[0, 1, 2].map((i) => (
              <div key={i}>
                <Skeleton className="h-7 w-24" />
                <Skeleton className="mt-2 h-3 w-16" />
              </div>
            ))}
          </div>
        )}
        {kind === "form" ? (
          <div className="workspace-general-form flex flex-col gap-7">
            {[0, 1, 2].map((i) => (
              <div key={i}>
                <Skeleton className="mb-3 h-3 w-28" />
                <Skeleton className={i === 1 ? "h-24 w-full" : "h-9 w-full"} />
              </div>
            ))}
          </div>
        ) : (
          [0, 1, 2].map((i) => (
            <div className="loading-list-row" key={i}>
              <Skeleton className="size-7 shrink-0" />
              <div className="flex flex-1 flex-col gap-2">
                <Skeleton className="h-3 w-28" />
                <Skeleton className="h-3 w-40 max-w-full" />
              </div>
              <Skeleton className="h-6 w-14" />
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export function MessagesSkeleton() {
  return (
    <div className="chat-loading" role="status" aria-label="Loading messages">
      <span className="sr-only">Loading messages</span>
      <div aria-hidden="true" className="flex flex-col gap-7">
        {[0, 1, 2].map((i) => (
          <div className="flex gap-3" key={i}>
            <Skeleton className="size-8 shrink-0" />
            <div className="flex flex-1 flex-col gap-2">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-3 w-3/4" />
              {i !== 1 && <Skeleton className="h-3 w-1/2" />}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function WorkspaceSkeleton({
  error,
  onRetry,
}: {
  error?: string;
  onRetry: () => void;
}) {
  return (
    <div className="team-shell workspace-placeholder">
      <aside className="team-sidebar" aria-hidden="true">
        <div className="workspace-brand">
          <Skeleton className="h-4 w-24" />
          <Mark />
        </div>
        <div className="loading-navigation">
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-5 w-3/4" />
          ))}
        </div>
      </aside>
      <main className="team-main">
        <header className="team-topbar">
          <Skeleton className="h-4 w-28" />
        </header>
        {error ? (
          <div className="chat-loading">
            <p role="alert">{error}</p>
            <Button variant="outline" className="self-start" onClick={onRetry}>
              Retry
            </Button>
          </div>
        ) : (
          <MessagesSkeleton />
        )}
        <div className="loading-composer" aria-hidden="true">
          <Skeleton className="h-20 w-full" />
        </div>
      </main>
    </div>
  );
}
