import { getConversation, TOKEN_ALERT_THRESHOLD } from "@/lib/conversations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Full transcript + token breakdown for one conversation. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const conversation = await getConversation(id);
  if (!conversation) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json({ threshold: TOKEN_ALERT_THRESHOLD, conversation });
}
