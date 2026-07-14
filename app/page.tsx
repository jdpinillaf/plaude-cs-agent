"use client";

import { useChat } from "@ai-sdk/react";
import { WorkflowChatTransport } from "@workflow/ai";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ApprovalRequest, CaseEvent, CaseStage, ConversationTokens, TriageResult } from "@/lib/types";

type Persona = { id: string; name: string; tier: string };
type Account = {
  customer: { id: string; name: string; email: string; tier: string; kycStatus: string; creditLimit: string; balance: string };
  card: { network: string; last4: string; status: string; maskedPan: string } | null;
  transactions: { id: string; amount: string; merchant: string; date: string; status: string }[];
};
type PanelItem = { request: ApprovalRequest; resolved?: { approved: boolean; reason?: string } };
type TimelineItem = { stage: CaseStage; note?: string };

const SUGGESTIONS: Record<string, string[]> = {
  cus_ana: [
    "SkyHigh Airlines charged me twice for $250 — please refund the duplicate.",
    "I want to raise my credit limit for an upcoming trip.",
  ],
  cus_ben: ["My account is frozen and I can't do anything — can you unlock it?", "What do you need from me to verify my identity?"],
  cus_lin: ["I don't recognize a $6,400 charge from CloudCompute — I think my card is compromised.", "Can you block my card and send a new one?"],
};

const STAGE: Record<CaseStage, { label: string; tone: string; dot: string }> = {
  gathering: { label: "Gathering facts", tone: "text-muted", dot: "bg-faint" },
  pending_approval: { label: "Waiting for approval", tone: "text-warn", dot: "bg-warn" },
  approved: { label: "Approved", tone: "text-positive", dot: "bg-positive" },
  denied: { label: "Denied", tone: "text-danger", dot: "bg-danger" },
  executed: { label: "Action executed", tone: "text-positive", dot: "bg-positive" },
  timed_out: { label: "Timed out", tone: "text-faint", dot: "bg-faint" },
  done: { label: "Turn complete", tone: "text-muted", dot: "bg-faint" },
};

const initials = (name: string) =>
  name.split(" ").map((w) => w[0]).slice(0, 2).join("").toUpperCase();

export default function Page() {
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [userId, setUserId] = useState("cus_ana");
  const [account, setAccount] = useState<Account | null>(null);
  const [view, setView] = useState<"customer" | "agent">("customer");
  const [switcherOpen, setSwitcherOpen] = useState(false);

  const [runId, setRunId] = useState<string | null>(null);
  const [panel, setPanel] = useState<Record<string, PanelItem>>({});
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const [triage, setTriage] = useState<TriageResult | null>(null);
  const [usage, setUsage] = useState<{ tokens: ConversationTokens; threshold: number; alert: boolean } | null>(null);
  const [input, setInput] = useState("");
  const [denyReason, setDenyReason] = useState<Record<string, string>>({});

  const setRunIdRef = useRef(setRunId);
  setRunIdRef.current = setRunId;
  const userIdRef = useRef(userId);
  userIdRef.current = userId;

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
  const { messages, sendMessage, setMessages, status } = useChat({ transport });

  const loadAccount = useCallback(async (id: string) => {
    const res = await fetch(`/api/account?userId=${id}`);
    if (res.ok) setAccount(await res.json());
  }, []);

  useEffect(() => {
    fetch("/api/account").then((r) => r.json()).then((d) => setPersonas(d.personas ?? []));
  }, []);
  useEffect(() => {
    loadAccount(userId);
  }, [userId, loadAccount]);

  // Case / approval / usage stream for the active run.
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
          const t = line.startsWith("data:") ? line.slice(5).trim() : line.trim();
          if (!t) continue;
          try {
            applyEvent(JSON.parse(t) as CaseEvent);
          } catch {}
        }
      }
    })().catch(() => {});
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  function applyEvent(e: CaseEvent) {
    if (e.kind === "status") {
      setTimeline((t) => [...t, { stage: e.stage, note: e.note }]);
      if (e.stage === "executed" || e.stage === "done") loadAccount(userIdRef.current);
    } else if (e.kind === "triage") setTriage(e.triage);
    else if (e.kind === "usage") setUsage({ tokens: e.tokens, threshold: e.threshold, alert: e.alert });
    else if (e.kind === "approval_request") setPanel((p) => ({ ...p, [e.request.token]: { request: e.request } }));
    else if (e.kind === "approval_resolved")
      setPanel((p) => (p[e.token] ? { ...p, [e.token]: { ...p[e.token], resolved: { approved: e.approved, reason: e.reason } } } : p));
  }

  async function decide(token: string, approved: boolean) {
    const reason = approved ? undefined : denyReason[token]?.trim() || "Not approved by reviewer";
    setPanel((p) => (p[token] ? { ...p, [token]: { ...p[token], resolved: { approved, reason } } } : p));
    await fetch("/api/slack/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, approved, reason }),
    });
  }

  function send(text: string) {
    const value = text.trim();
    if (!value) return;
    setInput("");
    setTriage(null);
    setUsage(null);
    sendMessage({ text: value }, { body: { userId } });
  }

  function switchUser(id: string) {
    setSwitcherOpen(false);
    if (id === userId) return;
    setUserId(id);
    setMessages([]);
    setPanel({});
    setTimeline([]);
    setTriage(null);
    setUsage(null);
    setRunId(null);
  }

  const pending = Object.values(panel).filter((i) => !i.resolved);
  const resolved = Object.values(panel).filter((i) => i.resolved);
  const busy = status === "submitted" || status === "streaming";
  const me = account?.customer;
  const firstName = me?.name.split(" ")[0] ?? "there";

  return (
    <div className="min-h-screen">
      {/* Top bar */}
      <header className="sticky top-0 z-20 border-b border-line bg-paper/85 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-4 px-5 py-3">
          <div className="flex items-baseline gap-2">
            <span className="font-serif text-2xl leading-none text-accent-ink">Vela</span>
            <span className="text-sm text-faint">Support</span>
          </div>

          <div className="ml-2 hidden rounded-full border border-line bg-surface p-0.5 sm:flex">
            {(["customer", "agent"] as const).map((v) => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={`rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors ${
                  view === v ? "bg-ink text-paper" : "text-muted hover:text-ink"
                }`}
              >
                {v === "customer" ? "Customer" : "Agent"}
              </button>
            ))}
          </div>

          <div className="ml-auto flex items-center gap-2">
            {view === "agent" && usage && (
              <span
                className={`tnum hidden rounded-full px-2.5 py-1 text-xs font-medium md:inline ${
                  usage.alert ? "bg-danger-soft text-danger" : "bg-accent-soft text-accent-ink"
                }`}
              >
                {usage.alert ? "⚠ " : ""}
                {usage.tokens.total.toLocaleString()} tokens
              </span>
            )}
            <Link href="/conversations" className="hidden text-sm text-muted hover:text-ink sm:block">
              History
            </Link>
            {/* user switcher */}
            <div className="relative">
              <button
                onClick={() => setSwitcherOpen((o) => !o)}
                className="flex items-center gap-2 rounded-full border border-line bg-surface py-1 pl-1 pr-2.5 hover:border-line-strong"
              >
                <span className="grid size-7 place-items-center rounded-full bg-accent text-xs font-semibold text-white">
                  {me ? initials(me.name) : "··"}
                </span>
                <span className="hidden text-sm font-medium sm:block">{me?.name ?? "…"}</span>
                <span className="text-faint">▾</span>
              </button>
              {switcherOpen && (
                <div className="absolute right-0 mt-2 w-60 overflow-hidden rounded-xl border border-line bg-surface shadow-lg shadow-ink/5">
                  <div className="px-3 py-2 text-xs uppercase tracking-wide text-faint">Signed in as</div>
                  {personas.map((p) => (
                    <button
                      key={p.id}
                      onClick={() => switchUser(p.id)}
                      className={`flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-paper ${
                        p.id === userId ? "bg-paper" : ""
                      }`}
                    >
                      <span className="grid size-7 place-items-center rounded-full bg-accent-soft text-xs font-semibold text-accent-ink">
                        {initials(p.name)}
                      </span>
                      <span className="flex-1">
                        <span className="block text-sm font-medium">{p.name}</span>
                        <span className="block text-xs capitalize text-muted">{p.tier}</span>
                      </span>
                      {p.id === userId && <span className="text-accent">●</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
        {/* mobile view toggle */}
        <div className="flex gap-1 border-t border-line px-5 py-2 sm:hidden">
          {(["customer", "agent"] as const).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={`flex-1 rounded-lg py-1.5 text-sm font-medium ${view === v ? "bg-ink text-paper" : "text-muted"}`}
            >
              {v === "customer" ? "Customer" : "Agent"}
            </button>
          ))}
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-5 py-6">
        {view === "customer" ? (
          <div className="grid gap-6 lg:grid-cols-[340px_1fr]">
            <AccountPanel account={account} />
            <Chat
              firstName={firstName}
              messages={messages}
              suggestions={SUGGESTIONS[userId] ?? []}
              onSend={send}
              input={input}
              setInput={setInput}
              busy={busy}
              pendingCount={pending.length}
            />
          </div>
        ) : (
          <AgentView
            pending={pending}
            resolved={resolved}
            timeline={timeline}
            triage={triage}
            usage={usage}
            denyReason={denyReason}
            setDenyReason={setDenyReason}
            onDecide={decide}
          />
        )}
      </main>
    </div>
  );
}

/* ── Account (customer) ─────────────────────────────────────────────────────── */
function AccountPanel({ account }: { account: Account | null }) {
  if (!account) return <div className="h-64 animate-pulse rounded-2xl bg-line/40" />;
  const { customer: c, card, transactions } = account;
  return (
    <aside className="space-y-6">
      {/* Card */}
      <div className="rise relative overflow-hidden rounded-2xl p-5 text-white shadow-lg shadow-accent/20"
        style={{ background: "linear-gradient(135deg, oklch(0.42 0.088 189), oklch(0.57 0.083 189))" }}>
        <div className="pointer-events-none absolute -right-10 -top-16 size-44 rounded-full bg-white/10" />
        <div className="flex items-start justify-between">
          <span className="font-serif text-xl leading-none">Vela</span>
          {card && card.status !== "active" && (
            <span className="rounded-full bg-white/20 px-2 py-0.5 text-[11px] capitalize">{card.status}</span>
          )}
        </div>
        <div className="tnum mt-8 text-lg tracking-[0.18em]">
          {card ? `•••• •••• •••• ${card.last4}` : "no card on file"}
        </div>
        <div className="mt-4 flex items-end justify-between">
          <div>
            <div className="text-[11px] uppercase tracking-wide text-white/60">Cardholder</div>
            <div className="text-sm font-medium">{c.name}</div>
          </div>
          <span className="text-sm capitalize text-white/80">{card?.network}</span>
        </div>
      </div>

      {/* Balance */}
      <div>
        <div className="text-[11px] uppercase tracking-wide text-faint">Available balance</div>
        <div className="tnum mt-1 font-serif text-4xl text-ink">{c.balance}</div>
        <dl className="mt-4 space-y-2 text-sm">
          <Detail label="Tier"><span className="capitalize">{c.tier}</span></Detail>
          <Detail label="KYC"><StatusChip status={c.kycStatus} /></Detail>
          <Detail label="Credit limit"><span className="tnum">{c.creditLimit}</span></Detail>
          <Detail label="Email"><span className="text-muted">{c.email}</span></Detail>
        </dl>
      </div>

      {/* Recent activity */}
      <div>
        <div className="mb-1 text-[11px] uppercase tracking-wide text-faint">Recent activity</div>
        <ul className="divide-y divide-line">
          {transactions.map((t) => (
            <li key={t.id} className="flex items-center justify-between gap-3 py-2.5">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">{t.merchant}</div>
                <div className="text-xs text-faint">
                  {t.date}
                  {t.status !== "settled" && <span className="ml-1.5 capitalize text-muted">· {t.status}</span>}
                </div>
              </div>
              <span className={`tnum text-sm ${t.status === "refunded" ? "text-positive" : "text-ink"}`}>
                {t.status === "refunded" ? "+" : "−"}
                {t.amount.replace("$", "$")}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </aside>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <dt className="text-muted">{label}</dt>
      <dd className="font-medium">{children}</dd>
    </div>
  );
}

function StatusChip({ status }: { status: string }) {
  const map: Record<string, string> = {
    verified: "bg-positive-soft text-positive",
    frozen: "bg-danger-soft text-danger",
    pending: "bg-warn-soft text-warn",
    active: "bg-positive-soft text-positive",
    blocked: "bg-danger-soft text-danger",
  };
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium capitalize ${map[status] ?? "bg-line text-muted"}`}>
      {status}
    </span>
  );
}

/* ── Chat (customer) ────────────────────────────────────────────────────────── */
function Chat({
  firstName,
  messages,
  suggestions,
  onSend,
  input,
  setInput,
  busy,
  pendingCount,
}: {
  firstName: string;
  messages: ReturnType<typeof useChat>["messages"];
  suggestions: string[];
  onSend: (t: string) => void;
  input: string;
  setInput: (v: string) => void;
  busy: boolean;
  pendingCount: number;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  return (
    <section className="flex min-h-[76vh] flex-col overflow-hidden rounded-2xl border border-line bg-surface">
      <div className="flex items-center gap-3 border-b border-line px-5 py-3.5">
        <span className="grid size-9 place-items-center rounded-full bg-accent-soft font-serif text-lg text-accent-ink">N</span>
        <div className="leading-tight">
          <div className="text-sm font-semibold">Nova</div>
          <div className="flex items-center gap-1.5 text-xs text-muted">
            <span className="size-1.5 rounded-full bg-positive" /> Vela Support · usually replies instantly
          </div>
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto px-5 py-5">
        {messages.length === 0 ? (
          <div className="rise max-w-md">
            <p className="font-serif text-2xl text-ink">Hi {firstName} — how can I help?</p>
            <p className="mt-1 text-sm text-muted">Ask about a charge, your card, limits, or your account. I&apos;ll handle it, and loop in a specialist when a change needs approval.</p>
            <div className="mt-4 space-y-2">
              {suggestions.map((s) => (
                <button
                  key={s}
                  onClick={() => onSend(s)}
                  className="block w-full rounded-xl border border-line bg-paper px-3.5 py-2.5 text-left text-sm text-ink transition-colors hover:border-accent hover:bg-accent-soft/40"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((m) => (
            <div key={m.id} className={`rise flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
              <div
                className={`max-w-[80%] whitespace-pre-wrap rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed ${
                  m.role === "user"
                    ? "rounded-br-md bg-ink text-paper"
                    : "rounded-bl-md bg-paper text-ink ring-1 ring-line"
                }`}
              >
                {m.parts.map((part, i) => {
                  if (part.type === "text") return <span key={i}>{part.text}</span>;
                  if (part.type.startsWith("tool-")) {
                    const p = part as { type: string; state?: string };
                    const done = p.state === "output-available";
                    return (
                      <span key={i} className="mt-1.5 flex items-center gap-1.5 text-xs text-faint">
                        <span className={`size-1.5 rounded-full ${done ? "bg-accent" : "bg-warn"}`} />
                        {p.type.replace("tool-", "")}
                      </span>
                    );
                  }
                  return null;
                })}
              </div>
            </div>
          ))
        )}
        {busy && pendingCount === 0 && (
          <div className="flex items-center gap-1.5 pl-1 text-sm text-faint">
            <Dot /> <Dot delay={120} /> <Dot delay={240} />
          </div>
        )}
        {pendingCount > 0 && (
          <div className="rise flex items-center gap-2 rounded-xl bg-warn-soft px-3.5 py-2.5 text-sm text-warn">
            <span className="size-1.5 animate-pulse rounded-full bg-warn" />
            Getting this approved by a specialist…
          </div>
        )}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSend(input);
        }}
        className="flex items-center gap-2 border-t border-line px-4 py-3"
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Message Nova…"
          className="flex-1 rounded-xl bg-paper px-3.5 py-2.5 text-sm outline-none ring-1 ring-line focus:ring-accent"
        />
        <button
          type="submit"
          disabled={busy}
          className="rounded-xl bg-accent px-4 py-2.5 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          Send
        </button>
      </form>
    </section>
  );
}

function Dot({ delay = 0 }: { delay?: number }) {
  return <span className="size-1.5 animate-bounce rounded-full bg-faint" style={{ animationDelay: `${delay}ms` }} />;
}

/* ── Agent operations view ──────────────────────────────────────────────────── */
function AgentView({
  pending,
  resolved,
  timeline,
  triage,
  usage,
  denyReason,
  setDenyReason,
  onDecide,
}: {
  pending: PanelItem[];
  resolved: PanelItem[];
  timeline: TimelineItem[];
  triage: TriageResult | null;
  usage: { tokens: ConversationTokens; threshold: number; alert: boolean } | null;
  denyReason: Record<string, string>;
  setDenyReason: (f: (d: Record<string, string>) => Record<string, string>) => void;
  onDecide: (token: string, approved: boolean) => void;
}) {
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
      <section>
        <h2 className="font-serif text-2xl text-ink">Approvals</h2>
        <p className="mb-4 text-sm text-muted">
          Sensitive actions Nova wants to run. This is what a specialist sees in Slack — approve, or deny with a reason
          and Nova reroutes the conversation.
        </p>
        <div className="space-y-3">
          {pending.length === 0 && resolved.length === 0 && (
            <div className="rounded-2xl border border-dashed border-line bg-surface px-5 py-10 text-center text-sm text-muted">
              No approval requests yet. Start a chat in the customer view and ask for a refund, a card block, or a limit
              increase.
            </div>
          )}
          {pending.map(({ request }) => (
            <ApprovalCard
              key={request.token}
              request={request}
              denyReason={denyReason[request.token] ?? ""}
              onDenyReason={(v) => setDenyReason((d) => ({ ...d, [request.token]: v }))}
              onApprove={() => onDecide(request.token, true)}
              onDeny={() => onDecide(request.token, false)}
            />
          ))}
          {resolved.map(({ request, resolved: r }) => (
            <div key={request.token} className="flex items-center justify-between rounded-2xl border border-line bg-surface px-4 py-3 opacity-75">
              <span className="text-sm font-medium">{request.title}</span>
              <span className={`text-sm font-medium ${r?.approved ? "text-positive" : "text-danger"}`}>
                {r?.approved ? "Approved" : `Denied${r?.reason ? ` · ${r.reason}` : ""}`}
              </span>
            </div>
          ))}
        </div>
      </section>

      <aside className="space-y-6">
        {triage && (
          <div className="rounded-2xl border border-line bg-surface p-4">
            <div className="mb-2 text-[11px] uppercase tracking-wide text-faint">
              Triage · <span className="font-mono text-accent-ink">{triage.model}</span>
            </div>
            <div className="mb-2 flex flex-wrap gap-1.5">
              {[triage.category, `urgency ${triage.urgency}`, `risk ${triage.riskHint}`].map((t) => (
                <span key={t} className="rounded-full bg-accent-soft px-2 py-0.5 text-xs capitalize text-accent-ink">{t}</span>
              ))}
            </div>
            <p className="text-sm text-muted">{triage.summary}</p>
          </div>
        )}

        {usage && (
          <div className={`rounded-2xl border p-4 ${usage.alert ? "border-danger/40 bg-danger-soft" : "border-line bg-surface"}`}>
            <div className="mb-2 text-[11px] uppercase tracking-wide text-faint">Token usage</div>
            <div className="tnum font-serif text-3xl text-ink">{usage.tokens.total.toLocaleString()}</div>
            <div className="mt-1 text-xs text-muted">
              triage {usage.tokens.triage.total.toLocaleString()} · agent {usage.tokens.agent.total.toLocaleString()} · limit{" "}
              {usage.threshold.toLocaleString()}
            </div>
            {usage.alert && <div className="mt-2 text-xs font-medium text-danger">⚠ Over budget — alert raised</div>}
          </div>
        )}

        <div className="rounded-2xl border border-line bg-surface p-4">
          <div className="mb-3 text-[11px] uppercase tracking-wide text-faint">Case timeline</div>
          <ol className="space-y-2.5">
            {timeline.length === 0 && <li className="text-sm text-muted">No events yet.</li>}
            {timeline.map((t, i) => (
              <li key={i} className="flex items-start gap-2.5 text-sm">
                <span className={`mt-1.5 size-1.5 shrink-0 rounded-full ${STAGE[t.stage].dot}`} />
                <span>
                  <span className={`font-medium ${STAGE[t.stage].tone}`}>{STAGE[t.stage].label}</span>
                  {t.note && <span className="text-faint"> · {t.note}</span>}
                </span>
              </li>
            ))}
          </ol>
        </div>
      </aside>
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
  const riskTone =
    request.riskLevel === "high" ? "bg-danger-soft text-danger" : request.riskLevel === "medium" ? "bg-warn-soft text-warn" : "bg-positive-soft text-positive";
  return (
    <div className="rise rounded-2xl border border-line bg-surface p-5">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="font-medium text-ink">{request.title}</h3>
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium capitalize ${riskTone}`}>{request.riskLevel} risk</span>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
        <Row label="Customer">{request.customer.name} · {request.customer.tier} · KYC {request.customer.kycStatus}</Row>
        {request.card && <Row label="Card">{request.card.maskedPan} · {request.card.status}</Row>}
        {request.transaction && <Row label="Transaction"><span className="tnum">{request.transaction.amountFormatted}</span> · {request.transaction.merchant} · {request.transaction.date}</Row>}
        <Row label="Action">{request.action}{request.amountFormatted ? ` · ${request.amountFormatted}` : ""}</Row>
        <Row label="Why">{request.justification}</Row>
      </dl>
      <input
        value={denyReason}
        onChange={(e) => onDenyReason(e.target.value)}
        placeholder="Reason to deny (Nova uses it to reroute)"
        className="mt-4 w-full rounded-lg bg-paper px-3 py-2 text-sm outline-none ring-1 ring-line focus:ring-accent"
      />
      <div className="mt-2.5 flex gap-2">
        <button onClick={onApprove} className="flex-1 rounded-lg bg-positive px-3 py-2 text-sm font-medium text-white hover:opacity-90">
          Approve
        </button>
        <button onClick={onDeny} className="flex-1 rounded-lg bg-surface px-3 py-2 text-sm font-medium text-danger ring-1 ring-danger/30 hover:bg-danger-soft">
          Deny
        </button>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-muted">{label}</dt>
      <dd className="text-ink">{children}</dd>
    </>
  );
}
