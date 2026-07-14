"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { ConversationRecord, ConversationSummary } from "@/lib/types";

export default function ConversationsPage() {
  const [items, setItems] = useState<ConversationSummary[]>([]);
  const [threshold, setThreshold] = useState(0);
  const [selected, setSelected] = useState<ConversationRecord | null>(null);
  const [loading, setLoading] = useState(true);

  async function refresh() {
    const res = await fetch("/api/conversations");
    const data = await res.json();
    setItems(data.conversations ?? []);
    setThreshold(data.threshold ?? 0);
    setLoading(false);
  }
  useEffect(() => {
    refresh();
  }, []);

  async function open(id: string) {
    const res = await fetch(`/api/conversations/${id}`);
    if (!res.ok) return;
    setSelected((await res.json()).conversation);
  }

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-line bg-paper/85 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-5 py-3">
          <div className="flex items-baseline gap-2">
            <span className="font-serif text-2xl leading-none text-accent-ink">Vela</span>
            <span className="text-sm text-faint">History</span>
          </div>
          <div className="ml-auto flex items-center gap-3">
            <button onClick={refresh} className="text-sm text-muted hover:text-ink">
              Refresh
            </button>
            <Link href="/" className="rounded-full border border-line bg-surface px-3 py-1 text-sm font-medium hover:border-line-strong">
              ← App
            </Link>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-5 py-6">
        <div className="mb-5">
          <h1 className="font-serif text-3xl text-ink">Conversation history</h1>
          <p className="text-sm text-muted">
            Token usage per conversation · alert threshold <span className="tnum">{threshold.toLocaleString()}</span> tokens
          </p>
        </div>

        <div className="grid gap-6 lg:grid-cols-2">
          <section className="overflow-hidden rounded-2xl border border-line bg-surface">
            <div className="border-b border-line px-4 py-2.5 text-[11px] uppercase tracking-wide text-faint">
              {items.length} conversation{items.length === 1 ? "" : "s"}
            </div>
            <ul className="divide-y divide-line">
              {loading && <li className="p-4 text-sm text-muted">Loading…</li>}
              {!loading && items.length === 0 && (
                <li className="p-4 text-sm text-muted">
                  No conversations yet. Start one in the{" "}
                  <Link href="/" className="text-accent-ink underline">
                    app
                  </Link>
                  .
                </li>
              )}
              {items.map((c) => (
                <li key={c.id}>
                  <button
                    onClick={() => open(c.id)}
                    className={`flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-paper ${
                      selected?.id === c.id ? "bg-paper" : ""
                    }`}
                  >
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">{c.customerName ?? "Unknown customer"}</div>
                      <div className="truncate text-xs text-faint">{c.title}</div>
                      <div className="mt-0.5 text-xs text-faint">
                        {c.status} · {c.turns} turn{c.turns === 1 ? "" : "s"} · {new Date(c.updatedAt).toLocaleString()}
                      </div>
                    </div>
                    <span
                      className={`tnum shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${
                        c.alert ? "bg-danger-soft text-danger" : "bg-accent-soft text-accent-ink"
                      }`}
                    >
                      {c.alert ? "⚠ " : ""}
                      {c.tokens.total.toLocaleString()}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>

          <section className="overflow-hidden rounded-2xl border border-line bg-surface">
            <div className="border-b border-line px-4 py-2.5 text-[11px] uppercase tracking-wide text-faint">
              {selected ? "Transcript" : "Select a conversation"}
            </div>
            {selected && (
              <div className="space-y-5 p-4">
                <div className="grid grid-cols-3 gap-3">
                  <Stat label="Triage" value={selected.tokens.triage.total} sub={selected.models.triage} />
                  <Stat label="Agent" value={selected.tokens.agent.total} sub={selected.models.agent} />
                  <Stat label="Total" value={selected.tokens.total} sub={selected.alert ? "over budget" : "within budget"} alert={selected.alert} />
                </div>

                {selected.actions.length > 0 && (
                  <div>
                    <div className="mb-1.5 text-[11px] uppercase tracking-wide text-faint">Actions</div>
                    <ul className="space-y-1 text-sm text-muted">
                      {selected.actions.map((a, i) => (
                        <li key={i}>• {a}</li>
                      ))}
                    </ul>
                  </div>
                )}

                <div>
                  <div className="mb-2 text-[11px] uppercase tracking-wide text-faint">Messages</div>
                  <div className="space-y-2.5">
                    {selected.messages.map((m, i) => (
                      <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                        <div
                          className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed ${
                            m.role === "user" ? "rounded-br-md bg-ink text-paper" : "rounded-bl-md bg-paper text-ink ring-1 ring-line"
                          }`}
                        >
                          {m.text}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}

function Stat({ label, value, sub, alert }: { label: string; value: number; sub?: string; alert?: boolean }) {
  return (
    <div className={`rounded-xl border p-3 ${alert ? "border-danger/40 bg-danger-soft" : "border-line bg-paper"}`}>
      <div className="tnum font-serif text-2xl text-ink">{value.toLocaleString()}</div>
      <div className="text-xs text-muted">{label} tokens</div>
      {sub && <div className="mt-0.5 truncate font-mono text-[10px] text-faint">{sub}</div>}
    </div>
  );
}
