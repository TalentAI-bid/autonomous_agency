import { Skeleton } from '@/components/ui/skeleton';

/**
 * Static stand-in for the app shell, shown until the saved login has been read
 * from storage. It is rendered on the server too, so the first paint is a real
 * layout (sidebar, top bar, content) instead of an empty page.
 */
export function ShellSkeleton() {
  return (
    <div className="app-shell" aria-busy="true" aria-label="Loading">
      <aside className="flex min-w-0 flex-col border-r border-line bg-bg-panel">
        <div className="flex h-[54px] items-center gap-2.5 px-4">
          <div className="grid size-7 place-items-center rounded-lg bg-accent text-[14px] font-semibold text-white">K</div>
          <div className="text-[14px] font-semibold tracking-[-0.01em] text-ink">Keenpipe</div>
        </div>
        <div className="flex flex-col gap-1 px-2 pt-3">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-8 w-full rounded-card" />
          ))}
        </div>
      </aside>

      <div className="main">
        <div className="flex h-[54px] shrink-0 items-center gap-4 border-b border-line bg-bg-panel px-5">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="ml-auto h-8 w-44 rounded-lg" />
        </div>
        <div className="flex-1 overflow-hidden p-5">
          <div className="mx-auto flex max-w-[940px] flex-col gap-4">
            <Skeleton className="h-8 w-56" />
            <div className="grid gap-4 sm:grid-cols-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-24 rounded-2xl" />
              ))}
            </div>
            <Skeleton className="h-64 w-full rounded-2xl" />
          </div>
        </div>
      </div>
    </div>
  );
}
