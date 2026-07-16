/**
 * Browser-visit classifier — the ONE brain that turns a raw domain into a
 * meaningful category. Chrome history lands ~300k visits; without this, half
 * fall into "other" and the browsing signal is unreadable. The categories are
 * chosen to be *behaviorally predictive* for the record's analysis, not generic
 * web taxonomy:
 *
 *   work        — building: own infrastructure, dev tools, dashboards, ops SaaS
 *   ai          — AI assistants / model tooling (where real research now hides)
 *   comms       — email, chat, meetings, calendar
 *   social      — feeds and other people's lives (the "watching" drift signal)
 *   video       — long-form / streaming consumption
 *   shopping    — marketplaces and retail
 *   travel      — flights/stays/booking (the documented exit-ramp early-warning)
 *   realestate  — apartments/housing (the "settling down" signal)
 *   news        — news outlets
 *   finance     — banking, markets, prediction/betting
 *   search      — bare search engines (intent lives elsewhere; kept separate so
 *                 it never inflates "work")
 *   other       — genuinely unclassified (kept small on purpose)
 *
 * Matching is by domain suffix or substring, most-specific first. The map is
 * seeded from the actual top domains in the record but generalizes (any
 * *.myshopify.com is shopping, any bank pattern is finance, …). Extend the map,
 * not the callers — CLI, the recategorize script and any rollup import this.
 */

export type BrowserCategory =
  | "work"
  | "ai"
  | "comms"
  | "social"
  | "video"
  | "shopping"
  | "travel"
  | "realestate"
  | "news"
  | "finance"
  | "search"
  | "other";

export const BROWSER_CATEGORIES: BrowserCategory[] = [
  "work",
  "ai",
  "comms",
  "social",
  "video",
  "shopping",
  "travel",
  "realestate",
  "news",
  "finance",
  "search",
  "other",
];

/** Exact-ish domain → category. Checked before the substring rules. */
const EXACT: Record<string, BrowserCategory> = {
  // --- work: own products, infra, dev + ops tooling ---
  "app.lobbywave.com": "work",
  "us.posthog.com": "work",
  "posthog.com": "work",
  "supabase.com": "work",
  "supabase.io": "work",
  "vercel.com": "work",
  "railway.app": "work",
  "coolify.io": "work",
  "npmjs.com": "work",
  "www.npmjs.com": "work",
  "smithery.ai": "work",
  "21st.dev": "work",
  "trello.com": "work",
  "linear.app": "work",
  "notion.so": "work",
  "www.notion.so": "work",
  "www.canva.com": "work",
  "canva.com": "work",
  "www.fiverr.com": "work",
  "app.smartlead.ai": "work",
  "app.brevo.com": "work",
  "ads.google.com": "work",
  "admin.google.com": "work",
  "search.google.com": "work",
  "console.cloud.google.com": "work",
  "www.producthunt.com": "work",
  "producthunt.com": "work",
  "stripe.com": "work",
  "dashboard.stripe.com": "work",
  // --- ai assistants / model tooling ---
  "chatgpt.com": "ai",
  "chat.openai.com": "ai",
  "claude.ai": "ai",
  "gemini.google.com": "ai",
  "aistudio.google.com": "ai",
  "platform.openai.com": "ai",
  "console.anthropic.com": "ai",
  "perplexity.ai": "ai",
  "www.perplexity.ai": "ai",
  "huggingface.co": "ai",
  "openrouter.ai": "ai",
  // --- comms ---
  "mail.google.com": "comms",
  "calendar.google.com": "comms",
  "meet.google.com": "comms",
  "web.whatsapp.com": "comms",
  "web.telegram.org": "comms",
  "slack.com": "comms",
  "app.slack.com": "comms",
  "outlook.office.com": "comms",
  "outlook.live.com": "comms",
  // --- social feeds ---
  "www.instagram.com": "social",
  "instagram.com": "social",
  "www.linkedin.com": "social",
  "linkedin.com": "social",
  "www.facebook.com": "social",
  "facebook.com": "social",
  "twitter.com": "social",
  "x.com": "social",
  "www.reddit.com": "social",
  "reddit.com": "social",
  "www.tiktok.com": "social",
  "tiktok.com": "social",
  "luma.com": "social",
  "lu.ma": "social",
  // --- video ---
  "www.youtube.com": "video",
  "youtube.com": "video",
  "m.youtube.com": "video",
  "www.netflix.com": "video",
  "netflix.com": "video",
  "www.twitch.tv": "video",
  "vimeo.com": "video",
  // --- shopping ---
  "www.amazon.com": "shopping",
  "amazon.com": "shopping",
  "www.ebay.com": "shopping",
  "ebay.com": "shopping",
  "poshmark.com": "shopping",
  "us.shein.com": "shopping",
  "www.aliexpress.us": "shopping",
  "aliexpress.com": "shopping",
  "www.etsy.com": "shopping",
  // --- travel (the exit-ramp signal) ---
  "www.airbnb.com": "travel",
  "airbnb.com": "travel",
  "www.booking.com": "travel",
  "booking.com": "travel",
  "www.kiwi.com": "travel",
  "www.edreams.net": "travel",
  "www.expedia.com": "travel",
  "www.skyscanner.com": "travel",
  "www.google.com/travel": "travel",
  "www.hostelworld.com": "travel",
  // --- real estate (the settling signal) ---
  "streeteasy.com": "realestate",
  "www.zillow.com": "realestate",
  "www.apartments.com": "realestate",
  "www.zumper.com": "realestate",
  // --- news ---
  "www.ynet.co.il": "news",
  "news.google.com": "news",
  "www.nytimes.com": "news",
  "www.bbc.com": "news",
  "www.haaretz.com": "news",
  "www.calcalist.co.il": "news",
  // --- finance / markets ---
  "polymarket.com": "finance",
  "www.coinbase.com": "finance",
  "kalshi.com": "finance",
  // --- bare search ---
  "www.google.com": "search",
  "www.bing.com": "search",
  "duckduckgo.com": "search",
};

/** Substring / suffix rules, checked in order after EXACT. First hit wins. */
const RULES: Array<[RegExp, BrowserCategory]> = [
  // own infra: raw server IPs and localhost are building, never "other"
  [/^\d{1,3}(\.\d{1,3}){3}(:\d+)?$/, "work"],
  [/^localhost(:\d+)?$/, "work"],
  [/\bvps\.flowengine\.cloud$/, "work"],
  [/\bflowengine\.cloud$/, "work"],
  [/\blitellm\./, "work"],
  [/\bgithub\.(com|io)$/, "work"],
  [/\bgitlab\.com$/, "work"],
  [/\bnetlify\.app$/, "work"],
  [/\bmyshopify\.com$/, "work"],
  [/\bcloudflare\.com$/, "work"],
  // ai
  [/\.openai\.com$/, "ai"],
  [/\.anthropic\.com$/, "ai"],
  // travel
  [/\b(hostel|hotel|hostels|ryanair|wizzair|easyjet|airlines|flights?)\b/, "travel"],
  // shopping
  [/\.myshopify\.com$/, "shopping"],
  // gov / legal (kept as other-but-labeled → folds into "other" bucket by default)
  // search engines with country TLDs
  [/^(www\.)?google\.[a-z.]+$/, "search"],
];

/** Normalize a raw domain/host: strip scheme, path, port kept for IP infra. */
export function normalizeDomain(raw: string): string {
  let d = (raw || "").trim().toLowerCase();
  if (!d) return "";
  d = d.replace(/^https?:\/\//, "");
  // keep host[:port]; drop path/query
  d = d.split("/")[0];
  return d;
}

/** Classify a single domain (or full URL host) into a behavioral category. */
export function categorizeDomain(raw: string): BrowserCategory {
  const d = normalizeDomain(raw);
  if (!d) return "other";
  if (EXACT[d]) return EXACT[d];
  // try without www.
  const bare = d.replace(/^www\./, "");
  if (EXACT[bare]) return EXACT[bare];
  for (const [re, cat] of RULES) {
    if (re.test(d)) return cat;
  }
  return "other";
}
