import fs from "fs";
import path from "path";
import { readConfig, writeConfig, type AppConfig } from "./config";
import {
  GOOGLE_LEAVES,
  GOOGLE_PRODUCTS,
  googleEnabled,
  googleMissingProducts,
  googleProductOn,
  isGoogleProduct,
} from "./google";
import { pluginInstanceById } from "./importers/registry";
import { connectionState } from "./importers/plugin";
import { recordDir } from "./paths";

/**
 * The Pipeline's GOOGLE CARD, server side.
 *
 * One card, one key, a tree of products (Google → Gmail → Sent). This is the state
 * behind it and the one writer for the checkboxes — the UI, the CLI (`agentqs
 * google`), the MCP tool and the API route all come through here.
 *
 * The connection rule is unchanged and absolute: connected ⇔ a stored credential.
 * Ticking a product is NOT connecting — it says what the one Google key is allowed
 * to bring in. Tick Gmail on a Calendar-only grant and you get
 * `needsAuthorize: true`, because the key in the drawer does not open that door yet.
 */

export interface GoogleProductState {
  id: string;
  parent: string | null;
  label: string;
  detail: string;
  metrics: string[];
  /** A leaf can be ticked. A branch (Gmail) reports on when any child is. */
  leaf: boolean;
  enabled: boolean;
  /** Rows actually landed in the record for this product's source. */
  hasData: boolean;
  lastSync: string | null;
}

export interface GoogleState {
  connected: boolean;
  /** The app credentials are saved but the dance never finished. */
  clientIdSet: boolean;
  products: GoogleProductState[];
  /** Ticked, but the stored grant was never granted the scope — e.g. ["Gmail"]. */
  missingProducts: string[];
  /** Something ticked needs a scope the grant lacks → the card shows Re-authorize. */
  needsAuthorize: boolean;
}

function grant(cfg: AppConfig | null) {
  // The shared slot, or the pre-shared-key Calendar grant that still lives under
  // its own id — both mean "Google is connected".
  return cfg?.sourceOAuth?.google ?? cfg?.sourceOAuth?.gcal;
}

export function googleState(
  cfg: AppConfig | null = readConfig(),
  dir: string = recordDir(),
): GoogleState {
  const g = grant(cfg);
  const connected = Boolean(g?.refreshToken || g?.accessToken);
  const missingProducts = googleMissingProducts(cfg);

  const products: GoogleProductState[] = GOOGLE_PRODUCTS.map((p) => {
    const leaf = GOOGLE_LEAVES.includes(p.id);
    const inst = p.plugin ? pluginInstanceById(p.plugin) : undefined;
    let hasData = false;
    let lastSync: string | null = null;
    if (inst) {
      const file = path.join(dir, "daily", `${inst.plugin.id}.csv`);
      hasData = connectionState(inst.plugin, cfg, inst.plugin.id, file).hasData;
      lastSync = cfg?.sourceSyncedAt?.[inst.plugin.id] ?? null;
    }
    return {
      id: p.id,
      parent: p.parent ?? null,
      label: p.label,
      detail: p.detail,
      metrics: p.metrics ?? [],
      leaf,
      enabled: googleProductOn(cfg, p.id),
      hasData,
      lastSync,
    };
  });

  return {
    connected,
    clientIdSet: Boolean(g?.clientId),
    products,
    missingProducts,
    needsAuthorize: connected && missingProducts.length > 0,
  };
}

/**
 * Set which Google products are on. Full replacement — the caller sends the list it
 * wants, exactly like the checkboxes read.
 *
 * Unticking is NOT deleting: the credential stays, the already-imported rows stay
 * in the record (they are the user's data and unticking a checkbox has never been a
 * licence to erase history). It only stops the next sync from pulling that product.
 */
export function setGoogleProducts(ids: string[]): GoogleState {
  const cfg = readConfig();
  if (!cfg) throw new Error("Run setup first.");
  const unknown = ids.filter((id) => !isGoogleProduct(id));
  if (unknown.length) {
    throw new Error(
      `Unknown Google product${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}. Known: ${GOOGLE_LEAVES.join(", ")}.`,
    );
  }
  cfg.googleProducts = [...new Set(ids)].sort();
  writeConfig(cfg);
  return googleState(cfg);
}

/** Tick/untick a few without resending the whole list — what the CLI flags do. */
export function toggleGoogleProducts(enable: string[], disable: string[]): GoogleState {
  const cfg = readConfig();
  const next = new Set(googleEnabled(cfg));
  for (const id of enable) next.add(id);
  for (const id of disable) next.delete(id);
  return setGoogleProducts([...next]);
}

/** Does this source's daily file exist at all? (Card copy: "nothing landed yet".) */
export function googleHasAnyData(dir: string = recordDir()): boolean {
  return GOOGLE_PRODUCTS.some((p) => {
    if (!p.plugin) return false;
    try {
      return fs.existsSync(path.join(dir, "daily", `${p.plugin}.csv`));
    } catch {
      return false;
    }
  });
}
