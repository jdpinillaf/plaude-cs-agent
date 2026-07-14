import { getRun } from "workflow/api";
import { sseFromObjects } from "@/lib/sse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Streams the `case` namespace (status changes + approval requests/resolutions)
 * for a given run, so the UI can drive the Slack review panel and case timeline.
 */
export async function GET(req: Request) {
  const runId = new URL(req.url).searchParams.get("runId");
  if (!runId) return new Response("missing runId", { status: 400 });

  const run = getRun(runId);
  return new Response(sseFromObjects(run.getReadable({ namespace: "case" })), {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
    },
  });
}
