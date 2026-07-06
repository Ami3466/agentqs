import fs from "fs";
import path from "path";
import { getCurrentUser } from "@/lib/session";
import { photoThumbDir } from "@/lib/paths";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Serve a photo thumbnail by id. Thumbnails live under the data dir (gitignored, off
 * the cloud) — the ORIGINALS are never exposed. The id is content-hash hex, so it's
 * validated to hex-only to foreclose any path traversal.
 */
export async function GET(req: Request) {
  if (!getCurrentUser()) return new Response("Not authenticated.", { status: 401 });
  const id = new URL(req.url).searchParams.get("id") ?? "";
  if (!/^[a-f0-9]{6,64}$/.test(id)) return new Response("Bad id.", { status: 400 });
  const file = path.join(photoThumbDir(), `${id}.webp`);
  if (!fs.existsSync(file)) return new Response("Not found.", { status: 404 });
  const buf = fs.readFileSync(file);
  return new Response(buf, {
    headers: { "content-type": "image/webp", "cache-control": "private, max-age=3600" },
  });
}
