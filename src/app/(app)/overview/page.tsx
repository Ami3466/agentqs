import { redirect } from "next/navigation";

/** The Overview tab is gone — its coverage heatmap is a section of Pipeline now, so
 *  the only question it answered ("what do I have, and where are the holes?") sits
 *  next to the sources that answer it. Old links and bookmarks land there. */
export default function OverviewPage() {
  redirect("/pipeline");
}
