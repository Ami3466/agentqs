"use client";

import Link from "next/link";
import { cn } from "@/components/ui";

/**
 * A Pipeline row's source name. Once the source has landed data the name links
 * to the Journal pre-filtered to it (/journal?source=<id>) — clicking an
 * integration answers "what data came from this?". No data yet → plain text.
 */
export function SourceTitle({
  id,
  name,
  hasData,
  title,
  className,
}: {
  /** Source id as it appears in the daily table's `source` column. */
  id: string;
  name: string;
  hasData: boolean;
  title?: string;
  /** Overrides the default text size (rows outside the standard list are smaller). */
  className?: string;
}) {
  const base = cn("truncate font-medium text-fg", className ?? "text-sm");
  if (!hasData) {
    return (
      <p className={base} title={title}>
        {name}
      </p>
    );
  }
  return (
    <Link
      href={`/journal?source=${encodeURIComponent(id)}`}
      className={cn(base, "block hover:text-accent hover:underline")}
      title={title ?? `See all ${name} data in the Journal`}
    >
      {name}
    </Link>
  );
}
