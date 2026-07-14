import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Lightweight, dependency-free RAG over the Vela knowledge base.
 *
 * The company handbook + FAQ (knowledge/*.md) are chunked by `##` section and
 * indexed with a lexical BM25-lite score. `searchKnowledge` retrieves the most
 * relevant sections for a query so the agent can ground its answers and its
 * approval justifications in real company policy — no embedding service or
 * external vector DB required, so it works offline and in every environment.
 */

export interface KnowledgeChunk {
  id: string;
  doc: string;
  title: string;
  text: string;
}

const DOCS = [
  { doc: "Vela Company & Policy Handbook", file: "vela-company.md" },
  { doc: "Vela Customer FAQ", file: "vela-faq.md" },
];

const STOPWORDS = new Set(
  "a an the of to in on for and or is are be it my me you your i we our do does how what when who can i'd will with without at as if not no do".split(
    " ",
  ),
);

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

function chunkMarkdown(doc: string, md: string): KnowledgeChunk[] {
  const chunks: KnowledgeChunk[] = [];
  const sections = md.split(/\n(?=## )/); // split before each "## " heading
  for (const section of sections) {
    const m = section.match(/^##\s+(.+)$/m);
    if (!m) continue;
    const title = m[1].trim();
    const text = section.replace(/^#.*$/gm, "").replace(/\n{2,}/g, "\n").trim();
    if (text.length < 20) continue;
    chunks.push({ id: `${doc}::${title}`, doc, title, text });
  }
  return chunks;
}

interface Index {
  chunks: KnowledgeChunk[];
  tokens: string[][]; // tokenized text per chunk
  df: Map<string, number>;
  avgLen: number;
}

let INDEX: Index | null = null;

function buildIndex(): Index {
  const chunks: KnowledgeChunk[] = [];
  for (const { doc, file } of DOCS) {
    const md = readFileSync(join(process.cwd(), "knowledge", file), "utf8");
    chunks.push(...chunkMarkdown(doc, md));
  }
  const tokens = chunks.map((c) => tokenize(`${c.title} ${c.text}`));
  const df = new Map<string, number>();
  for (const toks of tokens) {
    for (const t of new Set(toks)) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const avgLen = tokens.reduce((s, t) => s + t.length, 0) / Math.max(1, tokens.length);
  return { chunks, tokens, df, avgLen };
}

function getIndex(): Index {
  if (!INDEX) INDEX = buildIndex();
  return INDEX;
}

/** Retrieve the top-k most relevant knowledge-base sections for a query. */
export function searchKnowledge(query: string, k = 3): KnowledgeChunk[] {
  let idx: Index;
  try {
    idx = getIndex();
  } catch {
    return []; // knowledge files not available in this environment
  }
  const N = idx.chunks.length;
  const q = new Set(tokenize(query));
  if (q.size === 0) return [];

  const k1 = 1.5;
  const b = 0.75;
  const scored = idx.chunks.map((chunk, i) => {
    const toks = idx.tokens[i];
    const len = toks.length;
    const tf = new Map<string, number>();
    for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
    let score = 0;
    for (const term of q) {
      const f = tf.get(term);
      if (!f) continue;
      const df = idx.df.get(term) ?? 0.5;
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * len) / idx.avgLen)));
    }
    return { chunk, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((s) => s.chunk);
}
