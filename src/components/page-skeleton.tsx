import { Card, Skeleton, SkeletonRows } from "@/components/ui";

/**
 * What a tab shows for the moment between the click and its data.
 *
 * Every page in the app is a `force-dynamic` server shell (it reads the session
 * cookie) wrapping a client panel that fetches. Without a `loading.tsx`, Next holds
 * the OLD tab on screen for the whole round trip and the app feels like it ignored
 * the click; with one, the new tab paints immediately in its own shape. Same
 * heading geometry as PageHeader so the real page replaces this without moving.
 */
export function PageSkeleton({ rows = 6, rowHeight = "h-12" }: { rows?: number; rowHeight?: string }) {
  return (
    <div>
      <div className="mb-6 space-y-2">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-4 w-72 max-w-full" />
      </div>
      <Card className="p-4">
        <SkeletonRows rows={rows} rowClassName={rowHeight} label="Loading" />
      </Card>
    </div>
  );
}
