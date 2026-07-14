/**
 * End-to-end check of the human-in-the-loop loop, no LLM key required.
 * Run the dev server first:  AGENT_MOCK=1 APPROVAL_TIMEOUT=120s pnpm dev
 * Then:                      node scripts/e2e.mjs [approve|deny]
 *
 * It POSTs a customer message, waits for the approval request on the case
 * stream, resumes it (approve by default), and prints the event sequence plus
 * the assistant's final text.
 */
const base = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const mode = process.argv[2] === "deny" ? "deny" : "approve";
const log = (...a) => console.log(...a);

function readEvents(stream, onEvent) {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let buf = "";
  return (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        const t = line.startsWith("data:") ? line.slice(5).trim() : line.trim();
        if (!t) continue;
        try { onEvent(JSON.parse(t)); } catch {}
      }
    }
  })();
}

const res = await fetch(base + "/api/chat", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "Please refund my duplicate SkyHigh charge" }] }],
  }),
});
const runId = res.headers.get("x-workflow-run-id");
log(`POST /api/chat -> ${res.status} runId=${runId} (mode=${mode})`);
if (!runId) process.exit(1);

let text = "";
readEvents(res.body, (e) => {
  if (e.type === "text-delta" && e.delta) text += e.delta;
}).then(() => log("assistant:", JSON.stringify(text)));

const ce = await fetch(base + "/api/case-events?runId=" + runId);
const seq = [];
await Promise.race([
  readEvents(ce.body, async (e) => {
    seq.push(e.kind + (e.stage ? ":" + e.stage : ""));
    if (e.kind === "approval_request") {
      const token = e.request.token;
      await new Promise((r) => setTimeout(r, 200));
      const r = await fetch(base + "/api/slack/actions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token,
          approved: mode === "approve",
          reason: mode === "deny" ? "Amount exceeds policy; offer a partial refund or a formal dispute." : undefined,
        }),
      });
      log(`resume (${mode}) -> ${r.status}`);
    }
  }),
  new Promise((r) => setTimeout(r, 25000)),
]);
log("EVENTS:", seq.join(" | "));
process.exit(0);
