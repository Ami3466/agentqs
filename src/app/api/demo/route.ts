import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { clearDemo, isDemoSeeded, seedDemo } from "@/lib/demo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Generic demo data: POST loads it, DELETE clears it, GET reports whether it's on. */
export async function GET() {
  if (!getCurrentUser()) return unauth();
  return NextResponse.json({ seeded: isDemoSeeded() });
}

export async function POST() {
  if (!getCurrentUser()) return unauth();
  const { days } = seedDemo();
  return NextResponse.json({ ok: true, seeded: true, days });
}

export async function DELETE() {
  if (!getCurrentUser()) return unauth();
  clearDemo();
  return NextResponse.json({ ok: true, seeded: false });
}

function unauth() {
  return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
}
