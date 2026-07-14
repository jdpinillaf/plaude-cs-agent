import { getRun } from "workflow/api";
import { sseFromObjects } from "@/lib/sse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Reconnection endpoint used by WorkflowChatTransport to resume an interrupted
 * agent stream (network blip, page refresh, or serverless timeout).
 */
export async function GET(req: Request, ctx: { params: Promise<{ runId: string }> }) {
  const { runId } = await ctx.params;
  const startIndex = Number(new URL(req.url).searchParams.get("startIndex") ?? "0");
  const run = getRun(runId);

  return new Response(sseFromObjects(run.getReadable({ startIndex })), {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
    },
  });
}
