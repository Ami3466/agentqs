import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { readJournal } from "@/lib/journal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Per-day view of the rebuilt cache — metrics pivoted to columns, plus the
 * memos and sessions on each day. Powers the Journal Timeline + Table. */
export async function GET() {
  if (!getCurrentUser()) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  return NextResponse.json(readJournal());
}
