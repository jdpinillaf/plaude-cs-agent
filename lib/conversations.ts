import type {
  ConversationRecord,
  ConversationSummary,
  ConversationTokens,
  TokenUsage,
} from "./types";

/**
 * In-memory conversation history + token accounting.
 *
 * Records every conversation (transcript, per-model token usage, actions taken)
 * so the UI can show a history and flag conversations that burned a lot of
 * tokens. Persisted on globalThis so it survives hot-reload in dev and stays
 * warm within a serverless instance. For durable cross-instance history, swap
 * this module for Vercel KV / Postgres — the interface stays the same.
 */

/** Alert when a single conversation's total tokens exceed this. */
export const TOKEN_ALERT_THRESHOLD = Number(process.env.TOKEN_ALERT_THRESHOLD ?? 15_000);

const g = globalThis as unknown as {
  __csConversations?: Map<string, ConversationRecord>;
  __csAlerted?: Set<string>;
};
const conversations: Map<string, ConversationRecord> = (g.__csConversations ??= new Map());
const alerted: Set<string> = (g.__csAlerted ??= new Set());

/** Rough token estimate when a model doesn't report usage (e.g. mock mode). */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/** Returns true exactly once per conversation, when it first crosses the alert threshold. */
export function shouldSendAlert(id: string): boolean {
  const rec = conversations.get(id);
  if (!rec || !rec.alert || alerted.has(id)) return false;
  alerted.add(id);
  return true;
}

const zero = (): TokenUsage => ({ input: 0, output: 0, total: 0 });
const zeroTokens = (): ConversationTokens => ({ triage: zero(), agent: zero(), total: 0 });

function now(): string {
  return new Date().toISOString();
}

export function startConversation(input: {
  id: string;
  runId: string;
  title: string;
  models: { triage: string; agent: string };
  firstUserMessage?: string;
}): ConversationRecord {
  const existing = conversations.get(input.id);
  if (existing) return existing;
  const rec: ConversationRecord = {
    id: input.id,
    runId: input.runId,
    title: input.title.slice(0, 120),
    createdAt: now(),
    updatedAt: now(),
    turns: 0,
    status: "gathering",
    tokens: zeroTokens(),
    alert: false,
    models: input.models,
    messages: input.firstUserMessage ? [{ role: "user", text: input.firstUserMessage }] : [],
    actions: [],
  };
  conversations.set(input.id, rec);
  return rec;
}

function recompute(rec: ConversationRecord): ConversationTokens {
  rec.tokens.total = rec.tokens.triage.total + rec.tokens.agent.total;
  rec.alert = rec.tokens.total > TOKEN_ALERT_THRESHOLD;
  return rec.tokens;
}

export function addUsage(
  id: string,
  which: "triage" | "agent",
  usage: Partial<TokenUsage>,
): ConversationTokens {
  const rec = conversations.get(id);
  if (!rec) return zeroTokens();
  const bucket = rec.tokens[which];
  bucket.input += usage.input ?? 0;
  bucket.output += usage.output ?? 0;
  bucket.total += usage.total ?? (usage.input ?? 0) + (usage.output ?? 0);
  rec.updatedAt = now();
  return recompute(rec);
}

export function recordCustomer(id: string, customerId?: string, customerName?: string) {
  const rec = conversations.get(id);
  if (!rec) return;
  if (customerId) rec.customerId = customerId;
  if (customerName) rec.customerName = customerName;
  rec.updatedAt = now();
}

export function recordAction(id: string, action: string) {
  const rec = conversations.get(id);
  if (!rec) return;
  rec.actions.push(action);
  rec.updatedAt = now();
}

export function recordStatus(id: string, status: ConversationRecord["status"]) {
  const rec = conversations.get(id);
  if (!rec) return;
  rec.status = status;
  rec.updatedAt = now();
}

export function recordFinalMessages(
  id: string,
  messages: { role: "user" | "assistant"; text: string }[],
) {
  const rec = conversations.get(id);
  if (!rec) return;
  // keep the user's opening message, then append the transcript from this turn
  const opener = rec.messages.filter((m) => m.role === "user").slice(0, 1);
  rec.messages = messages.length ? messages : [...opener];
  rec.turns = rec.messages.filter((m) => m.role === "user").length;
  rec.updatedAt = now();
}

export function isOverThreshold(id: string): boolean {
  const rec = conversations.get(id);
  return rec ? rec.tokens.total > TOKEN_ALERT_THRESHOLD : false;
}

export function getConversation(id: string): ConversationRecord | undefined {
  return conversations.get(id);
}

export function listConversations(): ConversationSummary[] {
  return [...conversations.values()]
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    .map(({ messages: _messages, actions: _actions, ...summary }) => summary);
}
