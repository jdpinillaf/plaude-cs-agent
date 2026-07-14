import { listConversations, TOKEN_ALERT_THRESHOLD } from "@/lib/conversations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** List all stored conversations (newest first) with token usage + alert flags. */
export async function GET() {
  return Response.json({
    threshold: TOKEN_ALERT_THRESHOLD,
    conversations: await listConversations(),
  });
}
