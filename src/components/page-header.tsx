import type { ReactNode } from "react";
import Link from "next/link";

export function PageHeader({
  title,
  subtitle,
  action,
  helpHref,
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
  helpHref?: string; // in-app docs anchor explaining this page's data
}) {
  return (
    <div className="mb-6 flex items-start justify-between gap-4">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight text-fg">
          {title}
          {helpHref ? (
            <Link
              href={helpHref}
              title="How your data is stored"
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-border text-xs font-normal text-muted-fg hover:bg-muted hover:text-fg"
            >
              ?
            </Link>
          ) : null}
        </h1>
        {subtitle ? (
          <p className="mt-1 text-sm text-muted-fg">{subtitle}</p>
        ) : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}
