"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, Google, Spinner } from "@/components/icons";
import { SourceConnect } from "@/components/source-connect";
import { cn } from "@/components/ui";
import type { GoogleProductState, GoogleState } from "@/lib/google-connect";
import type { Interval, SourceView } from "@/lib/sources";

/**
 * GOOGLE — ONE CARD, ONE KEY.
 *
 * Google used to appear three times under three names, so "connect Google" had no
 * single meaning. Here it has one: the account connects once, and you tick what that
 * one key may bring in — Calendar, Gmail, and Gmail down to Inbox and Sent.
 *
 * A tick is NOT a connection (connected ⇔ a stored credential — the rule holds). It
 * says what the key is allowed to fetch. Tick a product the grant has no scope for
 * and the card asks you to re-authorize THE SAME key, instead of letting the next
 * sync die on a 403 nobody can read.
 *
 * Google's keyless products (Search, Maps, YouTube, Gemini…) have no API to connect
 * to at all, so they are not products of this key and do not belong in this card.
 * One line at the bottom points at the Chrome extension that does import them.
 *
 * The card wears the GOOGLE mark, never Calendar's — it is the account, not one of
 * its products.
 */
export function GoogleCard({
  rows,
  version,
  savingId,
  removingId,
  onIntervalChange,
  onRemove,
  onChanged,
  onUseExtension,
}: {
  /** The provider's source rows from /api/sources (gcal, gmail) — the card owns them. */
  rows: SourceView[];
  version: number;
  savingId: string | null;
  removingId: string | null;
  onIntervalChange: (id: string, i: Interval) => void;
  onRemove: (id: string) => void;
  onChanged: () => void;
  /** Jump to Automated imports → Google, where the keyless products are imported. */
  onUseExtension: () => void;
}) {
  const [state, setState] = useState<GoogleState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/google", { cache: "no-store" });
      if (res.ok) setState((await res.json()) as GoogleState);
    } catch {
      /* a failed probe must never blank a card the user is working in */
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, version]);

  /** Tick/untick. Optimistic — the checkbox answers instantly, the server confirms. */
  /**
   * Tick/untick — OPTIMISTIC, and it has to be. The checkbox is a controlled input,
   * so if it only moved once the server answered, the browser's own tick would be
   * yanked back off on the next render and the box would sit there looking broken
   * until the round-trip landed. It moves now; the server's answer reconciles it,
   * and a failure puts it back and says why.
   *
   * `ids` is a list because a branch (Gmail) moves all its leaves at once — one
   * click, one request, no half-ticked Gmail.
   */
  async function setProducts(ids: string[], on: boolean) {
    const before = state;
    setBusy(ids[0]);
    setError("");
    setState((prev) => (prev ? applyLocally(prev, ids, on) : prev));
    try {
      const res = await fetch("/api/google", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(on ? { enable: ids } : { disable: ids }),
      });
      const data = (await res.json()) as GoogleState & { error?: string };
      if (!res.ok) {
        setState(before); // the tick never happened — don't leave a lie on screen
        setError(data.error || "Could not update Google.");
        return;
      }
      setState(data);
      onChanged(); // the row list re-reads: an enabled product becomes syncable
    } catch (e) {
      setState(before);
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const products = state?.products ?? [];
  const tops = products.filter((p) => !p.parent);
  const connected = Boolean(state?.connected);

  /** The /api/sources row backing a product (Calendar → gcal, Gmail → gmail) — the
   *  card owns these rows, so they never also appear loose in the source list. */
  const productRow = (p: GoogleProductState): SourceView | undefined =>
    rows.find((r) => r.id === (p.id === "calendar" ? "gcal" : p.id));

  if (!state) {
    return (
      <div className="flex items-center gap-2 p-4 text-xs text-muted-fg">
        <Spinner width={13} height={13} /> Loading Google…
      </div>
    );
  }

  /*
   * NOT CONNECTED → one row, one Connect. Nothing else.
   *
   * You do not choose what to import from an account you have not connected: the
   * checkboxes describe what a KEY is allowed to fetch, and there is no key yet.
   * Showing them here asks the user to configure a thing that does not exist.
   * Connect first; the tree appears the moment there is something for it to govern.
   *
   * It is `gcal`'s connect form only because gcal carries the OAuth config — the
   * grant it writes is Google's, and Gmail reads the very same one.
   */
  if (!connected) {
    return (
      <div>
        <SourceConnect
          id="gcal"
          version={version}
          nameOverride="Google"
          iconId="google"
          onSyncStarted={onChanged}
        />
        <div className="px-4 pb-4">
          <ExtensionLine onClick={onUseExtension} />
        </div>
      </div>
    );
  }

  // CONNECTED → now the key exists, so now you say what it may bring in.
  return (
    <div className="p-4">
      <div className="flex items-center gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-muted text-fg">
          <Google width={18} height={18} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-fg">Google</span>
            <Check width={13} height={13} className="shrink-0 text-accent" />
          </div>
        </div>
      </div>

      {/* The one thing the user cannot work out alone: the key they hold does not
          open the door they just ticked. */}
      {state.needsAuthorize ? (
        <p className="mt-2 text-xs text-fg">
          {state.missingProducts.join(" and ")} needs a wider key — re-authorize below.
        </p>
      ) : null}

      {error ? <p className="mt-2 text-xs text-destructive">{error}</p> : null}

      <div className="mt-3 space-y-1">
        {tops.map((top) => {
          const kids = products.filter((p) => p.parent === top.id);
          const row = productRow(top);
          return (
            <div key={top.id}>
              <ProductCheck
                product={top}
                busy={busy === top.id}
                // A branch (Gmail) is ticked BY its children — ticking it turns them
                // all on, unticking turns them all off. One click, no orphan branch.
                onToggle={(on) =>
                  void setProducts(kids.length ? kids.map((k) => k.id) : [top.id], on)
                }
              />
              {kids.length ? (
                <div className="ml-6 border-l border-border pl-3">
                  {kids.map((kid) => (
                    <ProductCheck
                      key={kid.id}
                      product={kid}
                      busy={busy === kid.id}
                      onToggle={(on) => void setProducts([kid.id], on)}
                    />
                  ))}
                </div>
              ) : null}
              {/* Each ticked product gets its own sync + schedule — the SAME
                  SourceConnect every API source uses, wearing the product's name
                  (in a card that already says Google, "Google Calendar" says it twice). */}
              {top.enabled && row ? (
                <div className="mt-1 rounded-lg border border-border">
                  <SourceConnect
                    id={row.id}
                    version={version}
                    interval={row.interval}
                    due={row.due}
                    savingInterval={savingId === row.id}
                    removing={removingId === row.id}
                    job={row.job ?? null}
                    nameOverride={top.label}
                    iconId={row.id === "gmail" ? "gmail" : "gcal"}
                    onIntervalChange={(i) => onIntervalChange(row.id, i)}
                    onRemove={row.connected || row.hasData ? () => onRemove(row.id) : undefined}
                    onSyncStarted={onChanged}
                  />
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      {/* Widening the SAME key — a re-run of the dance, nothing new to paste. */}
      {state.needsAuthorize ? (
        <div className="mt-2 rounded-lg border border-border">
          <SourceConnect
            id="gcal"
            version={version}
            nameOverride="Re-authorize Google"
            iconId="google"
            onSyncStarted={onChanged}
          />
        </div>
      ) : null}

      <ExtensionLine onClick={onUseExtension} />
    </div>
  );
}

/**
 * The same rule the server applies (`googleProductOn`), applied locally so the
 * checkbox can move on click instead of waiting out a round-trip: set the leaves,
 * then re-derive each branch from them — a branch is on when any child is.
 * `needsAuthorize` is deliberately NOT guessed here; the server owns it and its
 * answer lands a moment later.
 */
function applyLocally(state: GoogleState, ids: string[], on: boolean): GoogleState {
  const touched = new Set(ids);
  const leaves = state.products.map((p) =>
    p.leaf && touched.has(p.id) ? { ...p, enabled: on } : p,
  );
  return {
    ...state,
    products: leaves.map((p) =>
      p.leaf ? p : { ...p, enabled: leaves.some((k) => k.parent === p.id && k.enabled) },
    ),
  };
}

/** The rest of Google (Search, Maps, YouTube, Gemini…) has no API to connect to, so
 *  it is not a product of this key and gets no checkbox — just the one line saying
 *  where it IS imported. Shown connected or not: you can import Google data with the
 *  extension without ever holding a key. */
function ExtensionLine({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mt-3 block w-full truncate border-t border-border pt-3 text-left text-xs text-muted-fg hover:text-fg"
      title="Search, Maps, YouTube, Chrome, Gemini and more — imported with the Chrome extension, no key needed."
    >
      For other Google data, use the Chrome extension →{" "}
      <span className="font-medium text-fg underline underline-offset-2">Automated imports › Google</span>
    </button>
  );
}

/** One checkbox: what it is, what it lands, whether it has landed anything. */
function ProductCheck({
  product,
  busy,
  onToggle,
}: {
  product: GoogleProductState;
  busy: boolean;
  onToggle: (on: boolean) => void;
}) {
  const metrics = product.metrics.join(", ");
  return (
    <label
      className="flex cursor-pointer items-center gap-2 py-1.5"
      title={metrics ? `Lands: ${metrics}` : product.detail}
    >
      <input
        type="checkbox"
        checked={product.enabled}
        disabled={busy}
        onChange={(e) => onToggle(e.target.checked)}
        className="h-3.5 w-3.5 shrink-0 rounded border-border accent-accent"
      />
      <span className={cn("shrink-0 text-xs font-medium", product.enabled ? "text-fg" : "text-muted-fg")}>
        {product.label}
      </span>
      <span className="min-w-0 flex-1 truncate text-xs text-muted-fg" title={product.detail}>
        {metrics || product.detail}
      </span>
      {busy ? <Spinner width={12} height={12} className="shrink-0 text-muted-fg" /> : null}
      {product.hasData ? (
        <span className="shrink-0 text-[10px] font-medium text-accent" title="Rows from this product are in your record">
          in record
        </span>
      ) : null}
    </label>
  );
}
