import crypto from "node:crypto";
import { WebClient } from "@slack/web-api";
import type { ApprovalRequest } from "./types";

/**
 * Slack integration for the human-in-the-loop approval step.
 *
 * If SLACK_BOT_TOKEN + SLACK_CHANNEL_ID are set, real Block Kit messages with
 * Approve / Deny buttons are posted to the channel. If not, the app runs in
 * "mock" mode: the same ApprovalRequest is rendered by the in-app Slack panel,
 * which posts to the exact same /api/slack/actions endpoint. Reviewers can try
 * the full flow with zero Slack setup.
 */
export function slackEnabled(): boolean {
  return Boolean(process.env.SLACK_BOT_TOKEN && process.env.SLACK_CHANNEL_ID);
}

const riskEmoji = { low: "🟢", medium: "🟡", high: "🔴" } as const;

/** Block Kit blocks — reused by real Slack and documented as the mock card shape. */
export function buildApprovalBlocks(req: ApprovalRequest) {
  const lines: string[] = [
    `*Customer:* ${req.customer.name} \`${req.customer.id}\` · ${req.customer.tier} · KYC ${req.customer.kycStatus}`,
    `*Email:* ${req.customer.email}`,
  ];
  if (req.card) lines.push(`*Card:* ${req.card.maskedPan} · ${req.card.status}`);
  if (req.transaction)
    lines.push(
      `*Transaction:* ${req.transaction.id} · ${req.transaction.amountFormatted} · ${req.transaction.merchant} · ${req.transaction.date} · ${req.transaction.status}`,
    );

  return [
    {
      type: "header",
      text: { type: "plain_text", text: `${riskEmoji[req.riskLevel]} Approval needed: ${req.title}` },
    },
    { type: "section", text: { type: "mrkdwn", text: lines.join("\n") } },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Agent wants to:* ${req.action}${req.amountFormatted ? ` (${req.amountFormatted})` : ""}\n*Why:* ${req.justification}`,
      },
    },
    { type: "context", elements: [{ type: "mrkdwn", text: `Risk: *${req.riskLevel}* · case \`${req.caseId}\`` }] },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          style: "primary",
          text: { type: "plain_text", text: "Approve" },
          action_id: "approve",
          value: JSON.stringify({ token: req.token, caseId: req.caseId, approved: true }),
        },
        {
          type: "button",
          style: "danger",
          text: { type: "plain_text", text: "Deny" },
          action_id: "deny",
          value: JSON.stringify({ token: req.token, caseId: req.caseId, approved: false }),
        },
      ],
    },
  ];
}

export async function postApprovalToSlack(req: ApprovalRequest): Promise<void> {
  if (!slackEnabled()) return; // mock mode: UI panel handles it
  const client = new WebClient(process.env.SLACK_BOT_TOKEN);
  await client.chat.postMessage({
    channel: process.env.SLACK_CHANNEL_ID as string,
    text: `Approval needed: ${req.title} for ${req.customer.name}`,
    blocks: buildApprovalBlocks(req) as never,
  });
}

/** Post a token-usage alert to Slack (no-op in mock mode). */
export async function postTokenAlertToSlack(input: {
  caseId: string;
  customerName?: string;
  total: number;
  threshold: number;
}): Promise<void> {
  if (!slackEnabled()) return;
  const client = new WebClient(process.env.SLACK_BOT_TOKEN);
  await client.chat.postMessage({
    channel: process.env.SLACK_CHANNEL_ID as string,
    text: `⚠️ High token usage: conversation for ${input.customerName ?? "a customer"} used ${input.total.toLocaleString()} tokens (threshold ${input.threshold.toLocaleString()}). case \`${input.caseId}\``,
  });
}

/** Verify a Slack request signature (v0 HMAC-SHA256). */
export function verifySlackSignature(headers: Headers, rawBody: string): boolean {
  const secret = process.env.SLACK_SIGNING_SECRET;
  if (!secret) return false;
  const ts = headers.get("x-slack-request-timestamp");
  const sig = headers.get("x-slack-signature");
  if (!ts || !sig) return false;
  // reject requests older than 5 minutes
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 60 * 5) return false;
  const base = `v0:${ts}:${rawBody}`;
  const mine = `v0=${crypto.createHmac("sha256", secret).update(base).digest("hex")}`;
  try {
    return crypto.timingSafeEqual(Buffer.from(mine), Buffer.from(sig));
  } catch {
    return false;
  }
}
