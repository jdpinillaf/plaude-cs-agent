import { convertToModelMessages, type ModelMessage, type UIMessage } from "ai";
import { start } from "workflow/api";
import { sseFromObjects } from "@/lib/sse";
import { supportAgentWorkflow } from "@/workflows/support-agent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Starts a durable Customer Success agent run for the incoming conversation.
 * Returns the agent's UI-message stream as the response body and the run id in
 * the `x-workflow-run-id` header (WorkflowChatTransport requires it, and the UI
 * uses it to subscribe to the case/approval stream).
 */
export async function POST(req: Request) {
  const { messages } = (await req.json()) as { messages: UIMessage[] };
  const caseId = crypto.randomUUID();
  const modelMessages = await convertToModelMessages(messages);
  const args: [string, ModelMessage[]] = [caseId, modelMessages];

  const run = await start(supportAgentWorkflow, args);

  return new Response(sseFromObjects(run.getReadable()), {
    headers: {
      "x-workflow-run-id": run.runId,
      "x-case-id": caseId,
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
    },
  });
}
