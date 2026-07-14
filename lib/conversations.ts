import { kv, redisEnabled } from "./redis";
import type {
  ConversationRecord,
  ConversationSummary,
  ConversationTokens,
  TokenUsage,
} from "./types";

/**
 * Conversation history + token accounting.
 *
 * Uses Upstash Redis when configured (KV_REST_API_URL/KV_REST_API_TOKEN — set by
 * the Vercel ↔ Upstash integration) so history persists across serverless
 * instances. Falls back to an in-memory store (globalThis) for local dev with no
 * Redis configured. Same interface either way.
 */

export const TOKEN_ALERT_THRESHOLD = Number(process.env.TOKEN_ALERT_THRESHOLD ?? 15_000);

const g = globalThis as unknown as {
  __csConversations?: Map<string, ConversationRecord>;
  __csAlerted?: Set<string>;
};
const mem: Map<string, ConversationRecord> = (g.__csConversations ??= new Map());
const memAlerted: Set<string> = (g.__csAlerted ??= new Set());

const KEY = (id: string) => `conv:${id}`;
const INDEX = "conv:index"; // sorted set, score = updatedAt (ms)

const zero = (): TokenUsage => ({ input: 0, output: 0, total: 0 });
const zeroTokens = (): ConversationTokens => ({ triage: zero(), agent: zero(), total: 0 });
const now = (): string => new Date().toISOString();

/** Rough token estimate when a model doesn't report usage (e.g. mock mode). */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

async function load(id: string): Promise<ConversationRecord | undefined> {
  if (redisEnabled) return kv.getJSON<ConversationRecord>(KEY(id));
  return mem.get(id);
}

async function save(rec: ConversationRecord): Promise<void> {
  rec.updatedAt = now();
  if (redisEnabled) {
    await kv.setJSON(KEY(rec.id), rec);
    await kv.zadd(INDEX, Date.parse(rec.updatedAt), rec.id);
  } else {
    mem.set(rec.id, rec);
  }
}

function recompute(rec: ConversationRecord): ConversationTokens {
  rec.tokens.total = rec.tokens.triage.total + rec.tokens.agent.total;
  rec.alert = rec.tokens.total > TOKEN_ALERT_THRESHOLD;
  return rec.tokens;
}

export async function startConversation(input: {
  id: string;
  runId: string;
  title: string;
  models: { triage: string; agent: string };
  firstUserMessage?: string;
}): Promise<void> {
  if (await load(input.id)) return;
  const rec: ConversationRecord = {
    id: input.id,
    runId: input.runId,
    title: input.title.slice(0, 120),
    createdAt: now(),
    updatedAt: now(),
    turns: input.firstUserMessage ? 1 : 0,
    status: "gathering",
    tokens: zeroTokens(),
    alert: false,
    models: input.models,
    messages: input.firstUserMessage ? [{ role: "user", text: input.firstUserMessage }] : [],
    actions: [],
  };
  await save(rec);
}

export async function addUsage(
  id: string,
  which: "triage" | "agent",
  usage: Partial<TokenUsage>,
): Promise<ConversationTokens> {
  const rec = await load(id);
  if (!rec) return zeroTokens();
  const bucket = rec.tokens[which];
  bucket.input += usage.input ?? 0;
  bucket.output += usage.output ?? 0;
  bucket.total += usage.total ?? (usage.input ?? 0) + (usage.output ?? 0);
  const tokens = recompute(rec);
  await save(rec);
  return tokens;
}

export async function recordCustomer(id: string, customerId?: string, customerName?: string) {
  const rec = await load(id);
  if (!rec) return;
  if (customerId) rec.customerId = customerId;
  if (customerName) rec.customerName = customerName;
  await save(rec);
}

export async function recordAction(id: string, action: string) {
  const rec = await load(id);
  if (!rec) return;
  rec.actions.push(action);
  await save(rec);
}

export async function recordStatus(id: string, status: ConversationRecord["status"]) {
  const rec = await load(id);
  if (!rec) return;
  rec.status = status;
  await save(rec);
}

export async function recordFinalMessages(
  id: string,
  messages: { role: "user" | "assistant"; text: string }[],
) {
  const rec = await load(id);
  if (!rec) return;
  const opener = rec.messages.filter((m) => m.role === "user").slice(0, 1);
  rec.messages = messages.length ? messages : opener;
  rec.turns = rec.messages.filter((m) => m.role === "user").length;
  await save(rec);
}

/** Returns true exactly once per conversation, when it first crosses the threshold. */
export async function shouldSendAlert(id: string): Promise<boolean> {
  const rec = await load(id);
  if (!rec || !rec.alert) return false;
  if (redisEnabled) return kv.setNX(`${KEY(id)}:alerted`, "1");
  if (memAlerted.has(id)) return false;
  memAlerted.add(id);
  return true;
}

export async function getConversation(id: string): Promise<ConversationRecord | undefined> {
  return load(id);
}

export async function listConversations(): Promise<ConversationSummary[]> {
  let records: ConversationRecord[] = [];
  if (redisEnabled) {
    const ids = await kv.zrangeRev(INDEX, 0, 99);
    if (ids.length) {
      const rows = await kv.mgetJSON<ConversationRecord>(ids.map(KEY));
      records = rows.filter((r): r is ConversationRecord => Boolean(r));
    }
  } else {
    records = [...mem.values()].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }
  return records.map(({ messages: _m, actions: _a, ...summary }) => summary);
}
