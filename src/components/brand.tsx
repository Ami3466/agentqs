import { Sparkles } from "./icons";

/** agentqs wordmark + mark. Shared by the shell and the auth pages. */
export function Brand({ size = "md" }: { size?: "md" | "lg" }) {
  const lg = size === "lg";
  return (
    <div className="flex items-center gap-2.5">
      <span
        className={
          lg
            ? "flex h-10 w-10 items-center justify-center rounded-xl bg-accent text-accent-fg shadow-sm"
            : "flex h-7 w-7 items-center justify-center rounded-lg bg-accent text-accent-fg shadow-sm"
        }
      >
        <Sparkles width={lg ? 22 : 16} height={lg ? 22 : 16} />
      </span>
      <span
        className={
          lg
            ? "text-xl font-semibold tracking-tight text-fg"
            : "text-[15px] font-semibold tracking-tight text-fg"
        }
      >
        agentqs
      </span>
    </div>
  );
}
