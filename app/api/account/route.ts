import { getAccount, listPersonas } from "@/lib/data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Logged-in user context. Without ?userId returns the list of demo personas (for
 * the account switcher); with ?userId returns that customer's full account view.
 */
export async function GET(req: Request) {
  const userId = new URL(req.url).searchParams.get("userId");
  if (!userId) return Response.json({ personas: listPersonas() });
  const account = getAccount(userId);
  if (!account) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json(account);
}
