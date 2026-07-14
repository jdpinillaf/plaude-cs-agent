/**
 * The Workflow runtime's getReadable() yields JS objects (UIMessageChunks or our
 * CaseEvents). An HTTP Response body must be bytes, so we frame each object as an
 * SSE `data: <json>\n\n` event. This is exactly the format WorkflowChatTransport's
 * `parseJsonEventStream` expects on the client, and what our case-events reader
 * parses too.
 */
export function sseFromObjects<T>(src: ReadableStream<T>): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const reader = src.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        controller.enqueue(enc.encode(`data: ${JSON.stringify(value)}\n\n`));
      } catch (err) {
        controller.error(err);
      }
    },
    cancel(reason) {
      reader.cancel(reason).catch(() => {});
    },
  });
}
