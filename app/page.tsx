"use client";

import { useChat } from "@ai-sdk/react";
import { WorkflowChatTransport } from "@workflow/ai";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ApprovalRequest, CaseEvent, CaseStage } from "@/lib/types";

type PanelItem = { request: ApprovalRequest; resolved?: { approved: boolean; reason?: string } };
type TimelineItem = { caseId: string; stage: CaseStage; note?: string; ts: number };

const STAGE_LABEL: Record<CaseStage, string> = {
  gathering: "Gathering facts",
  pending_approval: "Waiting for approval",
  approved: "Approved",
  denied: "Denied",
  executed: "Action executed",
  timed_out: "Timed out",
  done: "Turn complete",
};

const STAGE_COLOR: Record<CaseStage, string> = {
  gathering: "bg-slate-500",
  pending_approval: "bg-amber-500",
  approved: "bg-emerald-500",
  denied: "bg-rose-500",
  executed: "bg-emerald-600",
  timed_out: "bg-zinc-500",
  done: "bg-slate-600",
};

const SUGGESTIONS = [
  "Hi, I'm Ana Torres (ana@example.com). SkyHigh Airlines charged me twice for $250 — I want the duplicate refunded.",
  "I'm Ben Okafor, ben@example.com. My account is frozen and I can't do anything, please help me unlock it.",
  "This is Lin Zhao (lin@example.com). I don't recognize a $6,400 charge from CloudCompute — I think my card is compromised.",
];

export default function Page() {
  const [runId, setRunId] = useState<string | null>(null);
  const [panel, setPanel] = useState<Record<string, PanelItem>>({});
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const [input, setInput] = useState("");
  const [denyReason, setDenyReason] = useState<Record<string, string>>({});
  const setRunIdRef = useRef(setRunId);
  setRunIdRef.current = setRunId;

  const transport = useMemo(
    () =>
      new WorkflowChatTransport({
        api: "/api/chat",
        onChatSendMessage: (res) => {
          const id = res.headers.get("x-workflow-run-id");
          if (id) setRunIdRef.current(id);
        },
      }),
    [],
  );

  const { messages, sendMessage, status } = useChat({ transport });

  // Subscribe to the case/approval stream for the active run.
  useEffect(() => {
    if (!runId) return;
    const ac = new AbortController();
    (async () => {
      const res = await fetch(`/api/case-events?runId=${runId}`, { signal: ac.signal });
      if (!res.body) return;
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.startsWith("data:") ? line.slice(5).trim() : line.trim();
          if (!trimmed) continue;
          let event: CaseEvent;
          try {
            event = JSON.parse(trimmed);
          } catch {
            continue;
          }
          applyEvent(event);
        }
      }
    })().catch(() => {});
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  function applyEvent(event: CaseEvent) {
    if (event.kind === "status") {
      setTimeline((t) => [...t, { caseId: event.caseId, stage: event.stage, note: event.note, ts: Date.now() }]);
    } else if (event.kind === "approval_request") {
      setPanel((p) => ({ ...p, [event.request.token]: { request: event.request } }));
    } else if (event.kind === "approval_resolved") {
      setPanel((p) =>
        p[event.token]
          ? { ...p, [event.token]: { ...p[event.token], resolved: { approved: event.approved, reason: event.reason } } }
          : p,
      );
    }
  }

  async function decide(token: string, approved: boolean) {
    const reason = approved ? undefined : denyReason[token]?.trim() || "Not approved by reviewer";
    // optimistic resolve
    setPanel((p) => (p[token] ? { ...p, [token]: { ...p[token], resolved: { approved, reason } } } : p));
    await fetch("/api/slack/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, approved, reason }),
    });
  }

  function submit(text: string) {
    const value = text.trim();
    if (!value) return;
    setInput("");
    sendMessage({ text: value });
  }

  const pending = Object.values(panel).filter((i) => !i.resolved);
  const resolved = Object.values(panel).filter((i) => i.resolved);
  const busy = status === "submitted" || status === "streaming";

  return (
    <div className="mx-auto flex min-h-screen max-w-6xl flex-col gap-4 p-4 md:p-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Nova · Fintech Customer Success Agent</h1>
          <p className="text-sm text-zinc-500">Human-in-the-loop approvals over Slack · Workflow DevKit DurableAgent</p>
        </div>
        {pending.length > 0 && (
          <span className="animate-pulse rounded-full bg-amber-500/15 px-3 py-1 text-sm font-medium text-amber-600">
            {pending.length} awaiting approval
          </span>
        )}
      </header>

      <div className="grid flex-1 grid-cols-1 gap-4 lg:grid-cols-[1fr_420px]">
        {/* Customer chat */}
        <section className="flex min-h-[70vh] flex-col rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
          <div className="border-b border-zinc-200 px-4 py-2 text-sm font-medium dark:border-zinc-800">💬 Customer chat</div>
          <div className="flex-1 space-y-3 overflow-y-auto p-4">
            {messages.length === 0 && (
              <div className="space-y-2">
                <p className="text-sm text-zinc-500">Try a scenario:</p>
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    onClick={() => submit(s)}
                    className="block w-full rounded-lg border border-zinc-200 p-2 text-left text-sm hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900"
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}
            {messages.map((m) => (
              <div key={m.id} className={m.role === "user" ? "text-right" : "text-left"}>
                <div
                  className={`inline-block max-w-[85%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm ${
                    m.role === "user"
                      ? "bg-blue-600 text-white"
                      : "bg-zinc-100 text-zinc-900 dark:bg-zinc-900 dark:text-zinc-100"
                  }`}
                >
                  {m.parts.map((part, i) => {
                    if (part.type === "text") return <span key={i}>{part.text}</span>;
                    if (part.type.startsWith("tool-")) {
                      const p = part as { type: string; state?: string };
                      return (
                        <span key={i} className="mt-1 block text-xs italic text-zinc-500">
                          ⚙️ {p.type.replace("tool-", "")} · {p.state ?? "running"}
                        </span>
                      );
                    }
                    return null;
                  })}
                </div>
              </div>
            ))}
            {busy && pending.length === 0 && <div className="text-xs text-zinc-400">Nova is working…</div>}
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              submit(input);
            }}
            className="flex gap-2 border-t border-zinc-200 p-3 dark:border-zinc-800"
          >
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Message Nova as a customer…"
              className="flex-1 rounded-lg border border-zinc-300 bg-transparent px-3 py-2 text-sm outline-none focus:border-blue-500 dark:border-zinc-700"
            />
            <button type="submit" disabled={busy} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
              Send
            </button>
          </form>
        </section>

        {/* Ops / Slack review */}
        <section className="flex min-h-[70vh] flex-col gap-4">
          <div className="rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
            <div className="border-b border-zinc-200 px-4 py-2 text-sm font-medium dark:border-zinc-800">🧑‍💼 Slack review (mock)</div>
            <div className="space-y-3 p-3">
              {pending.length === 0 && resolved.length === 0 && (
                <p className="p-2 text-sm text-zinc-500">
                  No approval requests yet. When Nova needs to run a sensitive action, the case appears here for a human to
                  approve or deny — exactly what a teammate would see in Slack.
                </p>
              )}
              {pending.map(({ request }) => (
                <ApprovalCard
                  key={request.token}
                  request={request}
                  denyReason={denyReason[request.token] ?? ""}
                  onDenyReason={(v) => setDenyReason((d) => ({ ...d, [request.token]: v }))}
                  onApprove={() => decide(request.token, true)}
                  onDeny={() => decide(request.token, false)}
                />
              ))}
              {resolved.map(({ request, resolved: r }) => (
                <div key={request.token} className="rounded-lg border border-zinc-200 p-3 text-sm opacity-70 dark:border-zinc-800">
                  <div className="font-medium">{request.title}</div>
                  <div className={r?.approved ? "text-emerald-600" : "text-rose-600"}>
                    {r?.approved ? "✅ Approved" : `❌ Denied${r?.reason ? ` — ${r.reason}` : ""}`}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="flex-1 rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
            <div className="border-b border-zinc-200 px-4 py-2 text-sm font-medium dark:border-zinc-800">🕑 Case timeline</div>
            <ol className="space-y-2 p-3 text-sm">
              {timeline.length === 0 && <li className="text-zinc-500">No events yet.</li>}
              {timeline.map((t, i) => (
                <li key={i} className="flex items-center gap-2">
                  <span className={`h-2 w-2 rounded-full ${STAGE_COLOR[t.stage]}`} />
                  <span className="font-medium">{STAGE_LABEL[t.stage]}</span>
                  {t.note && <span className="text-zinc-500">· {t.note}</span>}
                </li>
              ))}
            </ol>
          </div>
        </section>
      </div>
    </div>
  );
}

function ApprovalCard({
  request,
  denyReason,
  onDenyReason,
  onApprove,
  onDeny,
}: {
  request: ApprovalRequest;
  denyReason: string;
  onDenyReason: (v: string) => void;
  onApprove: () => void;
  onDeny: () => void;
}) {
  const risk = { low: "🟢", medium: "🟡", high: "🔴" }[request.riskLevel];
  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50/40 p-3 dark:border-amber-500/40 dark:bg-amber-500/5">
      <div className="mb-2 font-semibold">
        {risk} {request.title}
      </div>
      <dl className="space-y-1 text-sm">
        <Row label="Customer">
          {request.customer.name} · {request.customer.tier} · KYC {request.customer.kycStatus}
        </Row>
        <Row label="Email">{request.customer.email}</Row>
        {request.card && (
          <Row label="Card">
            {request.card.maskedPan} · {request.card.status}
          </Row>
        )}
        {request.transaction && (
          <Row label="Transaction">
            {request.transaction.amountFormatted} · {request.transaction.merchant} · {request.transaction.date}
          </Row>
        )}
        <Row label="Action">
          {request.action}
          {request.amountFormatted ? ` (${request.amountFormatted})` : ""}
        </Row>
        <Row label="Why">{request.justification}</Row>
      </dl>
      <input
        value={denyReason}
        onChange={(e) => onDenyReason(e.target.value)}
        placeholder="Reason (required to deny) — Nova uses it to reroute"
        className="mt-2 w-full rounded-md border border-zinc-300 bg-transparent px-2 py-1 text-xs outline-none dark:border-zinc-700"
      />
      <div className="mt-2 flex gap-2">
        <button onClick={onApprove} className="flex-1 rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white">
          Approve
        </button>
        <button onClick={onDeny} className="flex-1 rounded-md bg-rose-600 px-3 py-1.5 text-sm font-medium text-white">
          Deny
        </button>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2">
      <dt className="w-24 shrink-0 text-zinc-500">{label}</dt>
      <dd className="flex-1">{children}</dd>
    </div>
  );
}
