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
    const data = await res.json();
    setSelected(data.conversation);
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-6xl flex-col gap-4 p-4 md:p-6">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold">Conversation history</h1>
          <p className="text-sm text-zinc-500">
            Token usage per conversation · alert threshold {threshold.toLocaleString()} tokens
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={refresh}
            className="rounded-full border border-zinc-300 px-3 py-1 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
          >
            Refresh
          </button>
          <Link
            href="/"
            className="rounded-full border border-zinc-300 px-3 py-1 text-sm font-medium hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
          >
            ← Chat
          </Link>
        </div>
      </header>

      <div className="grid flex-1 grid-cols-1 gap-4 lg:grid-cols-[1fr_1fr]">
        {/* List */}
        <section className="rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
          <div className="border-b border-zinc-200 px-4 py-2 text-sm font-medium dark:border-zinc-800">
            {items.length} conversation{items.length === 1 ? "" : "s"}
          </div>
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-900">
            {loading && <li className="p-4 text-sm text-zinc-500">Loading…</li>}
            {!loading && items.length === 0 && (
              <li className="p-4 text-sm text-zinc-500">
                No conversations yet. Start one in the{" "}
                <Link href="/" className="text-blue-600 underline">
                  chat
                </Link>
                .
              </li>
            )}
            {items.map((c) => (
              <li key={c.id}>
                <button
                  onClick={() => open(c.id)}
                  className={`flex w-full items-center justify-between gap-3 p-3 text-left hover:bg-zinc-50 dark:hover:bg-zinc-900 ${
                    selected?.id === c.id ? "bg-zinc-50 dark:bg-zinc-900" : ""
                  }`}
                >
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">{c.customerName ?? "Unknown customer"}</div>
                    <div className="truncate text-xs text-zinc-500">{c.title}</div>
                    <div className="mt-0.5 text-xs text-zinc-400">
                      {c.status} · {c.turns} turn{c.turns === 1 ? "" : "s"} · {new Date(c.updatedAt).toLocaleString()}
                    </div>
                  </div>
                  <span
                    className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${
                      c.alert ? "bg-rose-500/15 text-rose-600" : "bg-zinc-500/10 text-zinc-600 dark:text-zinc-300"
                    }`}
                  >
                    {c.alert ? "⚠️ " : ""}
                    {c.tokens.total.toLocaleString()} tok
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>

        {/* Detail */}
        <section className="rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
          <div className="border-b border-zinc-200 px-4 py-2 text-sm font-medium dark:border-zinc-800">
            {selected ? "Transcript" : "Select a conversation"}
          </div>
          {selected && (
            <div className="space-y-4 p-4">
              <div className="grid grid-cols-3 gap-2 text-center text-sm">
                <Stat label="Triage tokens" value={selected.tokens.triage.total} sub={selected.models.triage} />
                <Stat label="Agent tokens" value={selected.tokens.agent.total} sub={selected.models.agent} />
                <Stat label="Total" value={selected.tokens.total} sub={selected.alert ? "⚠️ over budget" : "ok"} alert={selected.alert} />
              </div>

              {selected.actions.length > 0 && (
                <div>
                  <div className="mb-1 text-xs font-medium text-zinc-500">Actions</div>
                  <ul className="space-y-1 text-sm">
                    {selected.actions.map((a, i) => (
                      <li key={i} className="text-zinc-600 dark:text-zinc-300">• {a}</li>
                    ))}
                  </ul>
                </div>
              )}

              <div>
                <div className="mb-1 text-xs font-medium text-zinc-500">Messages</div>
                <div className="space-y-2">
                  {selected.messages.map((m, i) => (
                    <div key={i} className={m.role === "user" ? "text-right" : "text-left"}>
                      <div
                        className={`inline-block max-w-[90%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm ${
                          m.role === "user"
                            ? "bg-blue-600 text-white"
                            : "bg-zinc-100 text-zinc-900 dark:bg-zinc-900 dark:text-zinc-100"
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
    </div>
  );
}

function Stat({ label, value, sub, alert }: { label: string; value: number; sub?: string; alert?: boolean }) {
  return (
    <div className={`rounded-lg border p-2 ${alert ? "border-rose-300 dark:border-rose-500/40" : "border-zinc-200 dark:border-zinc-800"}`}>
      <div className="text-lg font-semibold">{value.toLocaleString()}</div>
      <div className="text-xs text-zinc-500">{label}</div>
      {sub && <div className="mt-0.5 truncate font-mono text-[10px] text-zinc-400">{sub}</div>}
    </div>
  );
}
