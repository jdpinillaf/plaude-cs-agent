import { DurableAgent } from "@workflow/ai/agent";
import { mockSequenceModel } from "@workflow/ai/test";
import { createHook, getWritable, sleep } from "workflow";
import { generateObject } from "ai";
import { z } from "zod";
import type { ModelMessage, UIMessageChunk } from "ai";
import { AGENT_INSTRUCTIONS } from "@/lib/instructions";
import { searchKnowledge } from "@/lib/knowledge";
import {
  TOKEN_ALERT_THRESHOLD,
  addUsage,
  estimateTokens,
  getConversation,
  recordAction,
  recordCustomer,
  recordFinalMessages,
  recordStatus,
  shouldSendAlert,
  startConversation,
} from "@/lib/conversations";
import { postTokenAlertToSlack } from "@/lib/slack";
import {
  applyBlockAndReissue,
  applyFlagFraud,
  applyOpenDispute,
  applyRaiseLimit,
  applyRefund,
  applyUnlockKyc,
  findCustomer,
  getCard,
  getCardByCustomer,
  getCustomer,
  getTransaction,
  getTransactions,
  maskedPan,
  usd,
} from "@/lib/data";
import { postApprovalToSlack } from "@/lib/slack";
import type {
  ApprovalRequest,
  CaseEvent,
  RiskLevel,
  SensitiveTool,
  TriageResult,
} from "@/lib/types";

// Multi-model: a fast/cheap model triages every case; a stronger model runs the
// conversation + tool use. Both are swappable via env (Vercel AI Gateway slugs).
const AGENT_MODEL = process.env.AGENT_MODEL ?? "anthropic/claude-sonnet-4-5";
const TRIAGE_MODEL = process.env.TRIAGE_MODEL ?? "anthropic/claude-haiku-4-5";
/** How long a sensitive action waits for a human before timing out. */
const APPROVAL_TIMEOUT = process.env.APPROVAL_TIMEOUT ?? "24h";
/** Refunds at or below this auto-execute; above it require human approval. */
const REFUND_AUTO_LIMIT_CENTS = Number(process.env.REFUND_AUTO_LIMIT_CENTS ?? 10_000);

// ── Streaming helpers (steps: Node access, durable) ──────────────────────────
async function emitCase(event: CaseEvent) {
  "use step";
  // Persist to conversation history alongside streaming to the UI.
  try {
    if (event.kind === "status") {
      recordStatus(event.caseId, event.stage);
      if (["executed", "denied", "timed_out"].includes(event.stage) && event.note) {
        recordAction(event.caseId, `${event.stage}: ${event.note}`);
      }
    } else if (event.kind === "approval_request") {
      recordCustomer(event.request.caseId, event.request.customer.id, event.request.customer.name);
    }
  } catch {
    // history is best-effort; never break the stream
  }
  const writer = getWritable<CaseEvent>({ namespace: "case" }).getWriter();
  try {
    await writer.write(event);
  } finally {
    writer.releaseLock();
  }
}

interface ApprovalParams {
  caseId: string;
  toolCallId: string;
  tool: SensitiveTool;
  title: string;
  riskLevel: RiskLevel;
  action: string;
  justification: string;
  customerId: string;
  cardId?: string;
  transactionId?: string;
  amountCents?: number;
}

/** Build the reviewer-facing case context from the real record + post it. */
async function postApproval(token: string, p: ApprovalParams) {
  "use step";
  const customer = getCustomer(p.customerId);
  const card = p.cardId
    ? getCard(p.cardId)
    : p.customerId
      ? getCardByCustomer(p.customerId)
      : undefined;
  const txn = p.transactionId ? getTransaction(p.transactionId) : undefined;

  const request: ApprovalRequest = {
    token,
    caseId: p.caseId,
    tool: p.tool,
    title: p.title,
    riskLevel: p.riskLevel,
    action: p.action,
    justification: p.justification,
    amountFormatted: p.amountCents != null ? usd(p.amountCents) : undefined,
    customer: customer
      ? {
          id: customer.id,
          name: customer.name,
          email: customer.email,
          tier: customer.tier,
          kycStatus: customer.kycStatus,
        }
      : { id: p.customerId, name: "Unknown", email: "-", tier: "standard", kycStatus: "pending" },
    card: card ? { maskedPan: maskedPan(card), network: card.network, status: card.status } : undefined,
    transaction: txn
      ? {
          id: txn.id,
          amountFormatted: usd(txn.amountCents),
          merchant: txn.merchant,
          date: txn.date,
          status: txn.status,
        }
      : undefined,
    requestedAt: new Date().toISOString(),
  };

  await emitCase({ kind: "status", caseId: p.caseId, stage: "pending_approval", note: p.title });
  await emitCase({ kind: "approval_request", request });
  await postApprovalToSlack(request);
}

/**
 * The human-in-the-loop gate. Workflow-level (NOT a step) so it can use
 * createHook() + sleep(): posts the case to Slack/UI, then SUSPENDS until a
 * human resumes the hook via /api/slack/actions, or the timeout fires.
 */
async function requireApproval(
  p: ApprovalParams,
): Promise<{ approved: boolean; reason?: string; timedOut?: boolean }> {
  const token = `case:${p.caseId}:${p.toolCallId}`;

  // Register the resume hook BEFORE advertising the approval, so a human who
  // approves the instant they see the request can't race the hook registration.
  // Awaiting getConflict() suspends the workflow to commit the registration.
  using hook = createHook<{ approved: boolean; reason?: string }>({ token });
  await hook.getConflict();

  await postApproval(token, p);

  const sleepFor = sleep as (duration: string) => Promise<void>;
  const outcome = await Promise.race([
    hook.then((decision) => ({ kind: "resolved" as const, ...decision })),
    sleepFor(APPROVAL_TIMEOUT).then(() => ({ kind: "timeout" as const })),
  ]);

  if (outcome.kind === "timeout") {
    await emitCase({ kind: "approval_resolved", token, caseId: p.caseId, approved: false, reason: "timeout" });
    await emitCase({ kind: "status", caseId: p.caseId, stage: "timed_out" });
    return { approved: false, timedOut: true };
  }

  await emitCase({
    kind: "approval_resolved",
    token,
    caseId: p.caseId,
    approved: outcome.approved,
    reason: outcome.reason,
  });
  await emitCase({
    kind: "status",
    caseId: p.caseId,
    stage: outcome.approved ? "approved" : "denied",
    note: outcome.reason,
  });
  return { approved: outcome.approved, reason: outcome.reason };
}

// ── Mutation steps (run once approved) ───────────────────────────────────────
async function stepRefund(transactionId: string, amountCents: number) {
  "use step";
  return applyRefund(transactionId, amountCents);
}
async function stepBlockCard(cardId: string) {
  "use step";
  return applyBlockAndReissue(cardId);
}
async function stepRaiseLimit(customerId: string, newLimitCents: number) {
  "use step";
  return applyRaiseLimit(customerId, newLimitCents);
}
async function stepOpenDispute(transactionId: string) {
  "use step";
  return applyOpenDispute(transactionId);
}
async function stepUnlockKyc(customerId: string) {
  "use step";
  return applyUnlockKyc(customerId);
}
async function stepFlagFraud(customerId: string) {
  "use step";
  return applyFlagFraud(customerId);
}

// ── Read-only lookup tools (steps) ───────────────────────────────────────────
async function lookupCustomerStep(query: string) {
  "use step";
  const c = findCustomer(query);
  if (!c) return { found: false as const, message: `No customer matches "${query}".` };
  const card = getCardByCustomer(c.id);
  return {
    found: true as const,
    customer: {
      id: c.id,
      name: c.name,
      email: c.email,
      tier: c.tier,
      kycStatus: c.kycStatus,
      creditLimit: usd(c.creditLimitCents),
      balance: usd(c.balanceCents),
    },
    card: card ? { id: card.id, maskedPan: maskedPan(card), status: card.status } : null,
  };
}
async function lookupCardStep(args: { cardId?: string; customerId?: string }) {
  "use step";
  const card = args.cardId ? getCard(args.cardId) : args.customerId ? getCardByCustomer(args.customerId) : undefined;
  if (!card) return { found: false as const, message: "No card found." };
  return { found: true as const, card: { id: card.id, customerId: card.customerId, maskedPan: maskedPan(card), status: card.status } };
}
async function lookupTransactionsStep(customerId: string, limit: number) {
  "use step";
  const txns = getTransactions(customerId, limit);
  return {
    count: txns.length,
    transactions: txns.map((t) => ({
      id: t.id,
      amount: usd(t.amountCents),
      merchant: t.merchant,
      date: t.date,
      status: t.status,
    })),
  };
}

// ── RAG: consult the Vela knowledge base (step) ──────────────────────────────
async function searchKnowledgeStep(query: string) {
  "use step";
  const results = searchKnowledge(query, 3);
  if (results.length === 0)
    return { query, results: [], note: "No matching policy/FAQ found. Do not invent a policy." };
  return {
    query,
    results: results.map((r) => ({ source: `${r.doc} — ${r.title}`, content: r.text })),
  };
}

// ── Conversation history + token accounting steps ────────────────────────────
async function ensureConversationStep(
  caseId: string,
  firstUserMessage: string,
  models: { triage: string; agent: string },
) {
  "use step";
  startConversation({
    id: caseId,
    runId: caseId,
    title: firstUserMessage || "Conversation",
    models,
    firstUserMessage,
  });
}

/** Recompute totals, stream a usage event, and fire a one-time alert if over budget. */
async function emitUsageStep(caseId: string) {
  "use step";
  const rec = getConversation(caseId);
  const tokens = rec?.tokens ?? { triage: { input: 0, output: 0, total: 0 }, agent: { input: 0, output: 0, total: 0 }, total: 0 };
  const alert = (rec?.alert ?? false) === true;
  const writer = getWritable<CaseEvent>({ namespace: "case" }).getWriter();
  try {
    await writer.write({ kind: "usage", caseId, tokens, threshold: TOKEN_ALERT_THRESHOLD, alert });
  } finally {
    writer.releaseLock();
  }
  if (alert && shouldSendAlert(caseId)) {
    await postTokenAlertToSlack({
      caseId,
      customerName: rec?.customerName,
      total: tokens.total,
      threshold: TOKEN_ALERT_THRESHOLD,
    });
  }
}

async function recordAgentFinishStep(
  caseId: string,
  usage: { input: number; output: number; total: number },
  messages: { role: "user" | "assistant"; text: string }[],
) {
  "use step";
  addUsage(caseId, "agent", usage);
  recordFinalMessages(caseId, messages);
}

// ── Triage: a fast model classifies the case before the main agent (step) ────
async function triageStep(caseId: string, userText: string): Promise<TriageResult> {
  "use step";
  if (process.env.AGENT_MOCK === "1") {
    const summary = "Customer reports a duplicate charge and wants the duplicate refunded.";
    const tin = estimateTokens(userText);
    const tout = estimateTokens(summary);
    addUsage(caseId, "triage", { input: tin, output: tout, total: tin + tout });
    return {
      category: "refund",
      urgency: "medium",
      riskHint: "medium",
      summary,
      suggestedTools: ["searchKnowledgeBase", "lookupTransactions", "issueRefund"],
      model: "mock",
    };
  }
  try {
    const { object, usage } = await generateObject({
      model: TRIAGE_MODEL,
      schema: z.object({
        category: z.enum([
          "refund",
          "card_issue",
          "credit_limit",
          "dispute",
          "kyc_unlock",
          "fraud",
          "general",
          "other",
        ]),
        urgency: z.enum(["low", "medium", "high"]),
        riskHint: z.enum(["low", "medium", "high"]),
        summary: z.string().describe("one-sentence summary of what the customer needs"),
        suggestedTools: z.array(z.string()),
      }),
      prompt:
        "You are a triage classifier for a fintech Customer Success agent. Classify the customer's message: category, urgency, a risk hint for any action it may require, a one-sentence summary, and which tools are likely needed (from: searchKnowledgeBase, lookupCustomer, lookupCard, lookupTransactions, issueRefund, blockAndReissueCard, raiseCreditLimit, openDispute, unlockKyc, flagFraud).\n\nCustomer message:\n\"" +
        userText +
        '"',
    });
    addUsage(caseId, "triage", {
      input: usage?.inputTokens ?? 0,
      output: usage?.outputTokens ?? 0,
      total: usage?.totalTokens ?? 0,
    });
    return { ...object, model: TRIAGE_MODEL };
  } catch {
    return {
      category: "general",
      urgency: "medium",
      riskHint: "medium",
      summary: "Auto-triage unavailable; proceed by gathering facts.",
      suggestedTools: [],
      model: TRIAGE_MODEL,
    };
  }
}

function lastUserText(messages: ModelMessage[]): string {
  const last = [...messages].reverse().find((m) => m.role === "user");
  if (!last) return "";
  if (typeof last.content === "string") return last.content;
  if (Array.isArray(last.content))
    return last.content.map((p) => (p.type === "text" ? p.text : "")).join(" ").trim();
  return "";
}

function toTranscript(messages: ModelMessage[]): { role: "user" | "assistant"; text: string }[] {
  const out: { role: "user" | "assistant"; text: string }[] = [];
  for (const m of messages) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    let text = "";
    if (typeof m.content === "string") text = m.content;
    else if (Array.isArray(m.content))
      text = m.content.map((p) => (p.type === "text" ? p.text : "")).join(" ").trim();
    if (text) out.push({ role: m.role, text });
  }
  return out;
}

function caseIdOf(options: unknown): string {
  return (options as { experimental_context?: { caseId?: string } })?.experimental_context?.caseId ?? "unknown";
}

// ── The durable Customer Success agent ───────────────────────────────────────
const tools = {
  searchKnowledgeBase: {
    description:
      "Search Vela's company handbook & FAQ for policies, limits, timelines, fees, and answers. ALWAYS consult this before quoting a policy or proposing a sensitive action, and ground your Slack justification in what it returns.",
    inputSchema: z.object({ query: z.string().describe("policy or FAQ question, e.g. 'refund policy over $100'") }),
    execute: async ({ query }: { query: string }) => searchKnowledgeStep(query),
  },
  lookupCustomer: {
    description: "Look up a customer by id, email, or name. Returns profile, tier, KYC status, credit limit, balance, and their card.",
    inputSchema: z.object({ query: z.string().describe("customer id, email, or name") }),
    execute: async ({ query }: { query: string }) => lookupCustomerStep(query),
  },
  lookupCard: {
    description: "Look up a card by cardId or by customerId. Returns masked number and status.",
    inputSchema: z.object({ cardId: z.string().optional(), customerId: z.string().optional() }),
    execute: async (args: { cardId?: string; customerId?: string }) => lookupCardStep(args),
  },
  lookupTransactions: {
    description: "List a customer's recent transactions to find a disputed, duplicate, or fraudulent charge.",
    inputSchema: z.object({ customerId: z.string(), limit: z.number().int().min(1).max(20).optional() }),
    execute: async ({ customerId, limit }: { customerId: string; limit?: number }) =>
      lookupTransactionsStep(customerId, limit ?? 10),
  },

  issueRefund: {
    description: "Refund/reverse a charge to the customer's card. Refunds over $100 require human approval on Slack.",
    inputSchema: z.object({
      customerId: z.string(),
      transactionId: z.string(),
      amountUsd: z.number().positive(),
      reason: z.string().describe("what happened + why the refund is justified (shown to the reviewer)"),
    }),
    execute: async (
      { customerId, transactionId, amountUsd, reason }: { customerId: string; transactionId: string; amountUsd: number; reason: string },
      options: unknown,
    ) => {
      const caseId = caseIdOf(options);
      const toolCallId = (options as { toolCallId?: string })?.toolCallId ?? "call";
      const amountCents = Math.round(amountUsd * 100);

      if (amountCents <= REFUND_AUTO_LIMIT_CENTS) {
        const r = stepRefund ? await stepRefund(transactionId, amountCents) : null;
        await emitCase({ kind: "status", caseId, stage: "executed", note: `auto-approved refund ${usd(amountCents)}` });
        return { status: "executed" as const, autoApproved: true, ...r, message: "Refund within auto-approval limit; processed immediately." };
      }

      const decision = await requireApproval({
        caseId, toolCallId, tool: "issueRefund",
        title: `Refund ${usd(amountCents)}`,
        riskLevel: amountCents > 100_000 ? "high" : "medium",
        action: "Refund a charge back to the customer's card",
        justification: reason, customerId, transactionId, amountCents,
      });
      if (decision.timedOut) return { status: "timed_out" as const, message: "No approver responded. Do NOT promise the refund; tell the customer it's under review and offer to follow up." };
      if (!decision.approved) return { status: "denied" as const, reason: decision.reason, message: `Refund declined by reviewer. Reason: ${decision.reason ?? "unspecified"}. Follow the denial playbook — offer a partial refund or a formal dispute; do not retry.` };
      const r = await stepRefund(transactionId, amountCents);
      await emitCase({ kind: "status", caseId, stage: "executed", note: `refund ${usd(amountCents)}` });
      return { status: "executed" as const, ...r, message: "Refund approved and processed." };
    },
  },

  blockAndReissueCard: {
    description: "Block a card for fraud/loss and issue a replacement. Requires human approval.",
    inputSchema: z.object({ customerId: z.string(), cardId: z.string(), reason: z.string() }),
    execute: async ({ customerId, cardId, reason }: { customerId: string; cardId: string; reason: string }, options: unknown) => {
      const caseId = caseIdOf(options);
      const toolCallId = (options as { toolCallId?: string })?.toolCallId ?? "call";
      const decision = await requireApproval({
        caseId, toolCallId, tool: "blockAndReissueCard",
        title: "Block & reissue card", riskLevel: "high",
        action: "Block the card and issue a replacement", justification: reason, customerId, cardId,
      });
      if (decision.timedOut) return { status: "timed_out" as const, message: "No approver responded; card NOT blocked. Advise the customer to freeze the card in-app meanwhile." };
      if (!decision.approved) return { status: "denied" as const, reason: decision.reason, message: `Block declined. Reason: ${decision.reason ?? "unspecified"}. Offer a temporary hold / lower limit and show how to freeze the card in-app.` };
      const r = await stepBlockCard(cardId);
      await emitCase({ kind: "status", caseId, stage: "executed", note: "card blocked & reissued" });
      return { status: "executed" as const, ...r, message: "Card blocked and replacement issued." };
    },
  },

  raiseCreditLimit: {
    description: "Increase a customer's credit limit (high-value). Requires human approval.",
    inputSchema: z.object({ customerId: z.string(), newLimitUsd: z.number().positive(), reason: z.string() }),
    execute: async ({ customerId, newLimitUsd, reason }: { customerId: string; newLimitUsd: number; reason: string }, options: unknown) => {
      const caseId = caseIdOf(options);
      const toolCallId = (options as { toolCallId?: string })?.toolCallId ?? "call";
      const newLimitCents = Math.round(newLimitUsd * 100);
      const decision = await requireApproval({
        caseId, toolCallId, tool: "raiseCreditLimit",
        title: `Raise limit to ${usd(newLimitCents)}`, riskLevel: "high",
        action: "Increase the customer's credit limit", justification: reason, customerId, amountCents: newLimitCents,
      });
      if (decision.timedOut) return { status: "timed_out" as const, message: "No approver responded; limit unchanged. Offer to re-evaluate soon." };
      if (!decision.approved) return { status: "denied" as const, reason: decision.reason, message: `Limit increase declined. Reason: ${decision.reason ?? "unspecified"}. Offer re-evaluation in 30 days or a one-time temporary bump.` };
      const r = await stepRaiseLimit(customerId, newLimitCents);
      await emitCase({ kind: "status", caseId, stage: "executed", note: `limit → ${usd(newLimitCents)}` });
      return { status: "executed" as const, ...r, message: "Credit limit increased." };
    },
  },

  openDispute: {
    description: "Open a formal dispute / chargeback on a transaction. Requires human approval.",
    inputSchema: z.object({ customerId: z.string(), transactionId: z.string(), reason: z.string() }),
    execute: async ({ customerId, transactionId, reason }: { customerId: string; transactionId: string; reason: string }, options: unknown) => {
      const caseId = caseIdOf(options);
      const toolCallId = (options as { toolCallId?: string })?.toolCallId ?? "call";
      const decision = await requireApproval({
        caseId, toolCallId, tool: "openDispute",
        title: "Open dispute / chargeback", riskLevel: "medium",
        action: "Open a formal dispute on the transaction", justification: reason, customerId, transactionId,
      });
      if (decision.timedOut) return { status: "timed_out" as const, message: "No approver responded; dispute not opened yet." };
      if (!decision.approved) return { status: "denied" as const, reason: decision.reason, message: `Dispute declined. Reason: ${decision.reason ?? "unspecified"}. Gather more evidence (receipt, merchant contact) and offer to resubmit.` };
      const r = await stepOpenDispute(transactionId);
      await emitCase({ kind: "status", caseId, stage: "executed", note: "dispute opened" });
      return { status: "executed" as const, ...r, message: "Dispute opened." };
    },
  },

  unlockKyc: {
    description: "Lift a KYC/compliance freeze on an account. Requires human approval.",
    inputSchema: z.object({ customerId: z.string(), reason: z.string() }),
    execute: async ({ customerId, reason }: { customerId: string; reason: string }, options: unknown) => {
      const caseId = caseIdOf(options);
      const toolCallId = (options as { toolCallId?: string })?.toolCallId ?? "call";
      const decision = await requireApproval({
        caseId, toolCallId, tool: "unlockKyc",
        title: "Unlock KYC freeze", riskLevel: "high",
        action: "Lift the KYC/compliance freeze on the account", justification: reason, customerId,
      });
      if (decision.timedOut) return { status: "timed_out" as const, message: "No approver responded; account stays frozen." };
      if (!decision.approved) return { status: "denied" as const, reason: decision.reason, message: `Unlock declined. Reason: ${decision.reason ?? "unspecified"}. Explain what verification/document is still needed and how to submit it.` };
      const r = await stepUnlockKyc(customerId);
      await emitCase({ kind: "status", caseId, stage: "executed", note: "KYC unlocked" });
      return { status: "executed" as const, ...r, message: "KYC freeze lifted." };
    },
  },

  flagFraud: {
    description: "Freeze funds / flag an account for suspected fraud or misuse of funds (protective). Requires human approval.",
    inputSchema: z.object({ customerId: z.string(), reason: z.string() }),
    execute: async ({ customerId, reason }: { customerId: string; reason: string }, options: unknown) => {
      const caseId = caseIdOf(options);
      const toolCallId = (options as { toolCallId?: string })?.toolCallId ?? "call";
      const decision = await requireApproval({
        caseId, toolCallId, tool: "flagFraud",
        title: "Flag account for fraud", riskLevel: "high",
        action: "Freeze funds and flag the account for suspected fraud/misuse", justification: reason, customerId,
      });
      if (decision.timedOut) return { status: "timed_out" as const, message: "No approver responded; no freeze applied. Advise protective steps." };
      if (!decision.approved) return { status: "denied" as const, reason: decision.reason, message: `Freeze declined. Reason: ${decision.reason ?? "unspecified"}. Advise the customer on protective steps and offer to escalate with more detail.` };
      const r = await stepFlagFraud(customerId);
      await emitCase({ kind: "status", caseId, stage: "executed", note: "account flagged/frozen" });
      return { status: "executed" as const, ...r, message: "Account flagged and funds frozen." };
    },
  },
};

export async function supportAgentWorkflow(caseId: string, messages: ModelMessage[]) {
  "use workflow";

  const userText = lastUserText(messages);
  await ensureConversationStep(caseId, userText, { triage: TRIAGE_MODEL, agent: AGENT_MODEL });
  await emitCase({ kind: "status", caseId, stage: "gathering" });

  // Multi-model step 1: a fast model triages the incoming request.
  const triage = await triageStep(caseId, userText);
  await emitCase({ kind: "triage", caseId, triage });
  await emitUsageStep(caseId);

  const instructions = `${AGENT_INSTRUCTIONS}

# Automated triage (from a fast model: ${triage.model})
Category: ${triage.category} · urgency: ${triage.urgency} · risk hint: ${triage.riskHint}
Summary: ${triage.summary}
Likely tools: ${triage.suggestedTools.join(", ") || "—"}
Treat this as a hint only. Still gather facts with the lookup tools and consult
the knowledge base before acting.`;

  // AGENT_MOCK=1 lets the whole flow be exercised with no LLM key: the agent
  // deterministically consults the knowledge base, requests a $250 refund (needs
  // approval), then confirms. Used for the offline end-to-end verification.
  const model =
    process.env.AGENT_MOCK === "1"
      ? mockSequenceModel([
          {
            type: "tool-call",
            toolName: "searchKnowledgeBase",
            input: JSON.stringify({ query: "refund policy for a duplicate charge over $100" }),
          },
          {
            type: "tool-call",
            toolName: "issueRefund",
            input: JSON.stringify({
              customerId: "cus_ana",
              transactionId: "txn_1002",
              amountUsd: 250,
              reason:
                "Duplicate SkyHigh Airlines charge ($250) confirmed on txn_1002; per Vela refund policy amounts over $100 need approval; customer Ana Torres requests the duplicate refunded.",
            }),
          },
          {
            type: "text",
            text: "All set — I've handled the $250 duplicate SkyHigh Airlines charge on your Visa •••• 4242. Anything else I can help with?",
          },
        ])
      : AGENT_MODEL;

  // Multi-model step 2: the stronger model runs the conversation + tools.
  const agent = new DurableAgent({
    model,
    instructions,
    tools,
  });

  let agentUsage = { input: 0, output: 0, total: 0 };
  let transcript: { role: "user" | "assistant"; text: string }[] = [];

  const result = await agent.stream({
    messages,
    writable: getWritable<UIMessageChunk>(),
    experimental_context: { caseId },
    maxSteps: 14,
    onFinish: (event) => {
      const u = event.totalUsage;
      const input = u?.inputTokens ?? 0;
      const output = u?.outputTokens ?? 0;
      agentUsage = { input, output, total: u?.totalTokens ?? input + output };
      transcript = toTranscript(event.messages);
    },
  });

  // Fallback estimate if the model didn't report usage (e.g. mock mode).
  if (agentUsage.total === 0) {
    const text = (transcript.length ? transcript : toTranscript(result.messages))
      .map((m) => m.text)
      .join(" ");
    const est = estimateTokens(text);
    agentUsage = { input: Math.ceil(est * 0.6), output: Math.ceil(est * 0.4), total: est };
  }

  await recordAgentFinishStep(
    caseId,
    agentUsage,
    transcript.length ? transcript : toTranscript(result.messages),
  );
  await emitCase({ kind: "status", caseId, stage: "done" });
  await emitUsageStep(caseId);
  return result.messages;
}
