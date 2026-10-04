import { Skeleton } from "@/components/ui/skeleton";

export function DashboardSkeleton() {
  return <div className="min-h-dvh min-w-0 bg-background" role="status" aria-label="Loading your kitchen desk"><span className="sr-only">Loading workspace…</span><div className="mx-auto flex min-w-0 max-w-7xl flex-col gap-8 px-4 py-5 sm:px-6 lg:px-8" aria-hidden="true">
    <div className="flex min-w-0 items-center justify-between gap-3 border-b pb-5"><div className="flex min-w-0 items-center gap-3"><Skeleton className="size-9 shrink-0 rounded-xl" /><Skeleton className="h-5 w-24 min-w-0 sm:w-32" /></div><Skeleton className="h-9 w-20 shrink-0 sm:w-28" /></div>
    <div className="flex flex-col gap-3 py-5"><Skeleton className="h-4 w-36" /><Skeleton className="h-10 w-full max-w-lg" /><Skeleton className="h-4 w-full max-w-sm" /></div>
    <div className="grid grid-cols-4 gap-3 border-b pb-5 sm:flex sm:gap-6">{[0, 1, 2, 3].map((index) => <Skeleton key={index} className="h-4 w-full max-w-16" />)}</div>
    <div className="grid min-w-0 gap-10 lg:grid-cols-[minmax(0,1fr)_260px]"><div className="flex min-w-0 flex-col gap-7"><div className="grid grid-cols-2 items-center gap-4 border-b pb-7 sm:flex sm:gap-10"><Skeleton className="h-28 w-full max-w-36" /><Skeleton className="h-16 w-full max-w-36" /></div><Skeleton className="h-7 w-60 max-w-full" />{[0, 1, 2].map((index) => <Skeleton key={index} className="h-16 w-full" />)}</div><div className="flex min-w-0 flex-col gap-6 border-y border-dashed py-6"><Skeleton className="size-8" /><Skeleton className="h-6 w-36 max-w-full" /><Skeleton className="h-16 w-full" /><Skeleton className="h-16 w-full" /></div></div>
  </div></div>;
}
