import { resumeHook } from "workflow/api";
import { verifySlackSignature } from "@/lib/slack";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Resumes a paused sensitive-action workflow with a human decision.
 *
 * Two callers hit this same endpoint:
 *  1. The in-app "Slack" mock panel → JSON body { token, approved, reason }.
 *  2. A real Slack interactive message (Approve/Deny button) → signed,
 *     form-encoded `payload=<json>`.
 */
export async function POST(req: Request) {
  const contentType = req.headers.get("content-type") ?? "";

  // ── 1. In-app mock panel ───────────────────────────────────────────────────
  if (contentType.includes("application/json")) {
    const { token, approved, reason } = (await req.json()) as {
      token: string;
      approved: boolean;
      reason?: string;
    };
    if (!token) return Response.json({ ok: false, error: "missing token" }, { status: 400 });
    await resumeHook(token, { approved, reason, decidedBy: "mock-panel" });
    return Response.json({ ok: true });
  }

  // ── 2. Real Slack interactive payload ──────────────────────────────────────
  const raw = await req.text();
  if (!verifySlackSignature(req.headers, raw)) {
    return new Response("invalid signature", { status: 401 });
  }
  const params = new URLSearchParams(raw);
  const payload = JSON.parse(params.get("payload") ?? "{}");
  const action = payload.actions?.[0];
  const value = JSON.parse(action?.value ?? "{}") as { token?: string; approved?: boolean };
  if (!value.token) return new Response("missing token", { status: 400 });

  const approved = Boolean(value.approved);
  const reason = approved
    ? undefined
    : (payload.state?.values?.reason_block?.reason_input?.value as string | undefined) ??
      "Declined by reviewer in Slack";

  await resumeHook(value.token, {
    approved,
    reason,
    decidedBy: payload.user?.username ?? payload.user?.name ?? "slack",
  });

  // Replace the original message so the buttons can't be clicked twice.
  return Response.json({
    replace_original: true,
    text: approved ? "✅ Approved" : `❌ Denied${reason ? ` — ${reason}` : ""}`,
  });
}
