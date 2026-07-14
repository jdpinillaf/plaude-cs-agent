import type { Card, Customer, Transaction } from "./types";

/**
 * In-memory mock "core banking" data. Sensitive actions mutate this store so the
 * effect of an approval is visible (balance changes, card blocked, etc.).
 * Data resets when the dev server restarts. Persisted on globalThis to survive
 * Next.js hot-reload during development.
 */
interface Store {
  customers: Customer[];
  cards: Card[];
  transactions: Transaction[];
}

function seed(): Store {
  const customers: Customer[] = [
    {
      id: "cus_ana",
      name: "Ana Torres",
      email: "ana@example.com",
      tier: "premium",
      kycStatus: "verified",
      creditLimitCents: 500_000,
      balanceCents: 128_400,
    },
    {
      id: "cus_ben",
      name: "Ben Okafor",
      email: "ben@example.com",
      tier: "standard",
      kycStatus: "frozen",
      creditLimitCents: 150_000,
      balanceCents: 4_200,
    },
    {
      id: "cus_lin",
      name: "Lin Zhao",
      email: "lin@example.com",
      tier: "business",
      kycStatus: "verified",
      creditLimitCents: 1_200_000,
      balanceCents: 903_100,
    },
  ];

  const cards: Card[] = [
    { id: "card_ana", customerId: "cus_ana", network: "visa", last4: "4242", status: "active" },
    { id: "card_ben", customerId: "cus_ben", network: "mastercard", last4: "5599", status: "active" },
    { id: "card_lin", customerId: "cus_lin", network: "visa", last4: "7788", status: "active" },
  ];

  const transactions: Transaction[] = [
    { id: "txn_1001", customerId: "cus_ana", cardId: "card_ana", amountCents: 25_000, currency: "USD", merchant: "SkyHigh Airlines", date: "2026-07-10", status: "settled" },
    { id: "txn_1002", customerId: "cus_ana", cardId: "card_ana", amountCents: 25_000, currency: "USD", merchant: "SkyHigh Airlines", date: "2026-07-10", status: "settled" },
    { id: "txn_1003", customerId: "cus_ana", cardId: "card_ana", amountCents: 3_200, currency: "USD", merchant: "Corner Coffee", date: "2026-07-11", status: "settled" },
    { id: "txn_2001", customerId: "cus_ben", cardId: "card_ben", amountCents: 89_900, currency: "USD", merchant: "GadgetWorld", date: "2026-07-09", status: "settled" },
    { id: "txn_3001", customerId: "cus_lin", cardId: "card_lin", amountCents: 640_000, currency: "USD", merchant: "CloudCompute Inc", date: "2026-07-12", status: "settled" },
  ];

  return { customers, cards, transactions };
}

const g = globalThis as unknown as { __csStore?: Store };
export const store: Store = (g.__csStore ??= seed());

// ── Read helpers ────────────────────────────────────────────────────────────
export function findCustomer(query: string): Customer | undefined {
  const q = query.trim().toLowerCase();
  return store.customers.find(
    (c) =>
      c.id.toLowerCase() === q ||
      c.email.toLowerCase() === q ||
      c.name.toLowerCase() === q ||
      c.name.toLowerCase().includes(q),
  );
}

export function getCustomer(id: string): Customer | undefined {
  return store.customers.find((c) => c.id === id);
}

export function getCardByCustomer(customerId: string): Card | undefined {
  return store.cards.find((c) => c.customerId === customerId);
}

export function getCard(cardId: string): Card | undefined {
  return store.cards.find((c) => c.id === cardId);
}

export function getTransaction(id: string): Transaction | undefined {
  return store.transactions.find((t) => t.id === id);
}

export function getTransactions(customerId: string, limit = 10): Transaction[] {
  return store.transactions.filter((t) => t.customerId === customerId).slice(0, limit);
}

export function usd(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function maskedPan(card: Card): string {
  return `${card.network === "visa" ? "Visa" : "Mastercard"} •••• ${card.last4}`;
}

// ── Mutations (the real effect of an approved sensitive action) ──────────────
export function applyRefund(transactionId: string, amountCents: number) {
  const txn = getTransaction(transactionId);
  if (!txn) return { ok: false as const, error: "transaction not found" };
  const customer = getCustomer(txn.customerId);
  if (!customer) return { ok: false as const, error: "customer not found" };
  txn.status = "refunded";
  customer.balanceCents = Math.max(0, customer.balanceCents - amountCents);
  return { ok: true as const, refundedCents: amountCents, newBalance: usd(customer.balanceCents) };
}

export function applyBlockAndReissue(cardId: string) {
  const card = getCard(cardId);
  if (!card) return { ok: false as const, error: "card not found" };
  card.status = "reissued";
  const newLast4 = String(1000 + (parseInt(card.last4) % 9000)).padStart(4, "0");
  card.last4 = newLast4;
  return { ok: true as const, newCard: maskedPan(card), status: card.status };
}

export function applyRaiseLimit(customerId: string, newLimitCents: number) {
  const customer = getCustomer(customerId);
  if (!customer) return { ok: false as const, error: "customer not found" };
  const prev = customer.creditLimitCents;
  customer.creditLimitCents = newLimitCents;
  return { ok: true as const, previousLimit: usd(prev), newLimit: usd(newLimitCents) };
}

export function applyOpenDispute(transactionId: string) {
  const txn = getTransaction(transactionId);
  if (!txn) return { ok: false as const, error: "transaction not found" };
  txn.status = "disputed";
  return { ok: true as const, disputeId: `dsp_${transactionId.slice(-4)}`, status: txn.status };
}

export function applyUnlockKyc(customerId: string) {
  const customer = getCustomer(customerId);
  if (!customer) return { ok: false as const, error: "customer not found" };
  customer.kycStatus = "verified";
  return { ok: true as const, kycStatus: customer.kycStatus };
}

export function applyFlagFraud(customerId: string) {
  const customer = getCustomer(customerId);
  if (!customer) return { ok: false as const, error: "customer not found" };
  customer.kycStatus = "frozen";
  const card = getCardByCustomer(customerId);
  if (card) card.status = "blocked";
  return { ok: true as const, kycStatus: customer.kycStatus, card: card ? maskedPan(card) : undefined };
}
