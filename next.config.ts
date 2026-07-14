import type { NextConfig } from "next";
import { withWorkflow } from "workflow/next";

const nextConfig: NextConfig = {
  // Workflow steps run on the Node.js runtime.
  // Allow the dev server's HMR/_next resources over 127.0.0.1 and localhost
  // (Next 16 blocks cross-origin dev resources by default).
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  // Bundle the RAG knowledge-base markdown into serverless functions so the
  // searchKnowledgeBase step can read it at runtime on Vercel.
  outputFileTracingIncludes: {
    "/**": ["./knowledge/**/*.md"],
  },
};

export default withWorkflow(nextConfig);
