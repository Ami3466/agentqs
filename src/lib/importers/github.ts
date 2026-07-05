import fs from "fs";
import path from "path";
import { readConfig } from "../config";
import { parseCsv } from "../record";

/**
 * GitHub importer — the first Tier-1 source, end to end.
 *
 *   token → GitHub Search-Commits API → bucket by author-date → dense
 *   commits/day series → record/daily/github.csv (merged, idempotent).
 *
 * The record stays the source of truth: this only appends/updates one wide CSV
 * (`date,commits`); the SQLite cache is rebuilt from it by `rebuild()`. The
 * network layer is injectable (`fetchImpl`) so the normalize → write → rebuild
 * pipeline can be exercised offline with a fixture.
 */

export interface GithubDay {
  date: string; // YYYY-MM-DD
  commits: number;
}

export interface GithubFetchResult {
  login: string;
  from: string; // YYYY-MM-DD (inclusive)
  to: string; // YYYY-MM-DD (inclusive)
  days: GithubDay[]; // dense, ascending, zero-filled across [from..to]
  total: number; // commits counted in the window
  capped: boolean; // hit the Search API's 1000-result ceiling
}

export interface ImportGithubSummary extends GithubFetchResult {
  file: string; // record/daily/github.csv
  daysWithCommits: number;
  rowsInFile: number; // total rows after merge (may exceed the window)
}

export type FetchLike = typeof fetch;

const API = "https://api.github.com";
const PER_PAGE = 100;
const MAX_PAGES = 10; // Search API hard-caps results at 1000 (10 × 100)

function headers(token?: string): Record<string, string> {
  const h: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "agentqs-importer",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

async function bodyText(res: Response): Promise<string> {
  try {
    const t = (await res.text()).trim();
    return t.length > 200 ? t.slice(0, 200) + "…" : t;
  } catch {
    return "";
  }
}

/** Token precedence: explicit arg → GITHUB_TOKEN env → saved config. */
export function resolveGithubToken(explicit?: string): string | undefined {
  if (explicit && explicit.trim()) return explicit.trim();
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  return readConfig()?.githubToken?.trim() || undefined;
}

/** A trailing window of `days` days ending today (both bounds inclusive). */
export function windowDays(days: number, now: Date = new Date()): { from: string; to: string } {
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const from = new Date(to.getTime());
  from.setUTCDate(from.getUTCDate() - (Math.max(1, days) - 1));
  return { from: iso(from), to: iso(to) };
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** The authenticated user's login — needed to scope the commit search. */
export async function resolveLogin(token: string, fetchImpl: FetchLike = fetch): Promise<string> {
  const res = await fetchImpl(`${API}/user`, { headers: headers(token) });
  if (!res.ok) throw new Error(`GitHub /user → ${res.status}. ${await bodyText(res)}`);
  const j = (await res.json()) as { login?: string };
  if (!j.login) throw new Error("GitHub /user returned no login.");
  return j.login;
}

function densify(counts: Map<string, number>, from: string, to: string): GithubDay[] {
  const days: GithubDay[] = [];
  const cur = new Date(from + "T00:00:00Z");
  const end = new Date(to + "T00:00:00Z");
  while (cur.getTime() <= end.getTime()) {
    const key = iso(cur);
    days.push({ date: key, commits: counts.get(key) ?? 0 });
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return days;
}

interface SearchItem {
  commit?: { author?: { date?: string } };
}
interface SearchPage {
  total_count?: number;
  items?: SearchItem[];
}

/**
 * Fetch real commits/day for a user over [from..to] via the Search-Commits API,
 * bucketed by the commit's author-date (the day you actually committed, in the
 * author's own timezone). Paginates to the API's 1000-result ceiling.
 */
export async function fetchGithubCommits(opts: {
  token?: string;
  login?: string;
  from: string;
  to: string;
  fetchImpl?: FetchLike;
}): Promise<GithubFetchResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  let login = opts.login?.trim();
  if (!login) {
    if (!opts.token) throw new Error("Give a --login or a token so the author can be resolved.");
    login = await resolveLogin(opts.token, fetchImpl);
  }

  const counts = new Map<string, number>();
  let fetched = 0;
  let total = 0;
  let capped = false;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = new URL(`${API}/search/commits`);
    url.searchParams.set("q", `author:${login} author-date:${opts.from}..${opts.to}`);
    url.searchParams.set("sort", "author-date");
    url.searchParams.set("order", "asc");
    url.searchParams.set("per_page", String(PER_PAGE));
    url.searchParams.set("page", String(page));

    const res = await fetchImpl(url.toString(), { headers: headers(opts.token) });
    if (!res.ok) throw new Error(`GitHub search → ${res.status}. ${await bodyText(res)}`);
    const j = (await res.json()) as SearchPage;
    const items = j.items ?? [];
    for (const it of items) {
      const d = it.commit?.author?.date;
      if (!d) continue;
      const day = d.slice(0, 10); // author-local calendar day
      counts.set(day, (counts.get(day) ?? 0) + 1);
      total++;
    }
    fetched += items.length;
    if (items.length < PER_PAGE) break;
    if (page === MAX_PAGES && (j.total_count ?? 0) > fetched) capped = true;
  }

  return { login, from: opts.from, to: opts.to, days: densify(counts, opts.from, opts.to), total, capped };
}

/** Serialize a dense series to the record's wide CSV shape. */
export function githubCsv(days: GithubDay[]): string {
  return ["date,commits", ...days.map((d) => `${d.date},${d.commits}`)].join("\n") + "\n";
}

/** Read record/daily/github.csv back into an ascending commits/day series. */
export function parseGithubCsv(text: string): GithubDay[] {
  const { header, rows } = parseCsv(text);
  const di = header.indexOf("date");
  const ci = header.indexOf("commits");
  if (di < 0 || ci < 0) return [];
  return rows
    .map((r) => {
      const n = Number((r[ci] ?? "").trim());
      return { date: (r[di] ?? "").trim(), commits: Number.isFinite(n) ? n : 0 };
    })
    .filter((d) => d.date !== "")
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/**
 * Merge a fresh window into record/daily/github.csv. Dates inside the window are
 * overwritten with the new counts (zeros included); dates outside it are kept.
 * Idempotent: re-running the same import yields byte-identical output.
 */
export function writeGithubRecord(
  recordDir: string,
  days: GithubDay[],
): { file: string; rowsInFile: number } {
  const dailyDir = path.join(recordDir, "daily");
  fs.mkdirSync(dailyDir, { recursive: true });
  const file = path.join(dailyDir, "github.csv");

  const map = new Map<string, number>();
  if (fs.existsSync(file)) {
    const { header, rows } = parseCsv(fs.readFileSync(file, "utf8"));
    const di = header.indexOf("date");
    const ci = header.indexOf("commits");
    if (di >= 0 && ci >= 0) {
      for (const r of rows) {
        const date = (r[di] ?? "").trim();
        if (!date) continue;
        const n = Number((r[ci] ?? "").trim());
        map.set(date, Number.isFinite(n) ? n : 0);
      }
    }
  }
  for (const d of days) map.set(d.date, d.commits);

  const merged = [...map.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([date, commits]) => ({ date, commits }));
  fs.writeFileSync(file, githubCsv(merged), "utf8");
  return { file, rowsInFile: merged.length };
}

/** Fetch → normalize → write the record. Rebuilding the cache is the caller's job. */
export async function importGithub(opts: {
  token?: string;
  login?: string;
  from: string;
  to: string;
  recordDir: string;
  fetchImpl?: FetchLike;
}): Promise<ImportGithubSummary> {
  const res = await fetchGithubCommits({
    token: opts.token,
    login: opts.login,
    from: opts.from,
    to: opts.to,
    fetchImpl: opts.fetchImpl,
  });
  const w = writeGithubRecord(opts.recordDir, res.days);
  return {
    ...res,
    file: w.file,
    daysWithCommits: res.days.filter((d) => d.commits > 0).length,
    rowsInFile: w.rowsInFile,
  };
}
