export type RiskLevel = "low" | "medium" | "high";

export type CardStatus = "active" | "blocked" | "reissued";
export type KycStatus = "verified" | "pending" | "frozen";
export type CustomerTier = "standard" | "premium" | "business";
export type TxnStatus = "settled" | "pending" | "disputed" | "refunded";

export interface Customer {
  id: string;
  name: string;
  email: string;
  tier: CustomerTier;
  kycStatus: KycStatus;
  creditLimitCents: number;
  balanceCents: number;
}

export interface Card {
  id: string;
  customerId: string;
  network: "visa" | "mastercard";
  last4: string;
  status: CardStatus;
}

export interface Transaction {
  id: string;
  customerId: string;
  cardId: string;
  amountCents: number;
  currency: string;
  merchant: string;
  date: string; // ISO
  status: TxnStatus;
}

/** The name of every tool that must go through Slack human approval. */
export type SensitiveTool =
  | "issueRefund"
  | "blockAndReissueCard"
  | "raiseCreditLimit"
  | "openDispute"
  | "unlockKyc"
  | "flagFraud";

/** Lifecycle of a support case, streamed to the UI timeline. */
export type CaseStage =
  | "gathering"
  | "pending_approval"
  | "approved"
  | "denied"
  | "executed"
  | "timed_out"
  | "done";

/**
 * The full context a human reviewer sees in Slack (and the mock panel) to make
 * an informed approve/deny decision. Built server-side from the real record.
 */
export interface ApprovalRequest {
  token: string;
  caseId: string;
  tool: SensitiveTool;
  title: string;
  riskLevel: RiskLevel;
  action: string;
  justification: string;
  amountFormatted?: string;
  customer: {
    id: string;
    name: string;
    email: string;
    tier: CustomerTier;
    kycStatus: KycStatus;
  };
  card?: { maskedPan: string; network: string; status: CardStatus };
  transaction?: {
    id: string;
    amountFormatted: string;
    merchant: string;
    date: string;
    status: TxnStatus;
  };
  requestedAt: string;
}

/** How a human resolves a pending approval. */
export interface ApprovalDecision {
  approved: boolean;
  reason?: string;
  decidedBy?: string;
}

/** Output of the fast triage model that runs before the main agent. */
export interface TriageResult {
  category:
    | "refund"
    | "card_issue"
    | "credit_limit"
    | "dispute"
    | "kyc_unlock"
    | "fraud"
    | "general"
    | "other";
  urgency: "low" | "medium" | "high";
  riskHint: RiskLevel;
  summary: string;
  suggestedTools: string[];
  model: string;
}

/** Token usage for a model call or a whole conversation. */
export interface TokenUsage {
  input: number;
  output: number;
  total: number;
}

/** Per-conversation token breakdown across the two models. */
export interface ConversationTokens {
  triage: TokenUsage;
  agent: TokenUsage;
  total: number;
}

/** Events streamed on the `case` namespace → drive the Slack panel + timeline. */
export type CaseEvent =
  | { kind: "status"; caseId: string; stage: CaseStage; note?: string }
  | { kind: "triage"; caseId: string; triage: TriageResult }
  | { kind: "approval_request"; request: ApprovalRequest }
  | {
      kind: "approval_resolved";
      token: string;
      caseId: string;
      approved: boolean;
      reason?: string;
    }
  | {
      kind: "usage";
      caseId: string;
      tokens: ConversationTokens;
      threshold: number;
      alert: boolean;
    };

/** A stored conversation (history). */
export interface ConversationSummary {
  id: string; // caseId
  runId: string;
  customerId?: string;
  customerName?: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  turns: number;
  status: CaseStage;
  tokens: ConversationTokens;
  alert: boolean;
  models: { triage: string; agent: string };
}

export interface ConversationRecord extends ConversationSummary {
  messages: { role: "user" | "assistant"; text: string }[];
  actions: string[];
}
