/**
 * Minimal Upstash Redis REST client built on `fetch`.
 *
 * The @upstash/redis SDK references `EventTarget`, which isn't available inside
 * the Workflow step runtime, so we talk to the Upstash REST API directly. Values
 * are stored as JSON strings. No-ops (returns disabled) when the KV env vars are
 * not set — callers fall back to their in-memory store.
 */
const URL = process.env.KV_REST_API_URL;
const TOKEN = process.env.KV_REST_API_TOKEN;

export const redisEnabled = Boolean(URL && TOKEN);

async function cmd<T = unknown>(args: (string | number)[]): Promise<T> {
  const res = await fetch(URL as string, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(`redis ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { result: T };
  return data.result;
}

export const kv = {
  async getJSON<T>(key: string): Promise<T | undefined> {
    const r = await cmd<string | null>(["GET", key]);
    return r ? (JSON.parse(r) as T) : undefined;
  },
  async setJSON(key: string, value: unknown): Promise<void> {
    await cmd(["SET", key, JSON.stringify(value)]);
  },
  /** SET key value NX → true if newly set (used for one-time alerts). */
  async setNX(key: string, value: string): Promise<boolean> {
    const r = await cmd<string | null>(["SET", key, value, "NX"]);
    return r === "OK";
  },
  async zadd(key: string, score: number, member: string): Promise<void> {
    await cmd(["ZADD", key, score, member]);
  },
  async zrangeRev(key: string, start: number, stop: number): Promise<string[]> {
    return (await cmd<string[]>(["ZRANGE", key, start, stop, "REV"])) ?? [];
  },
  async mgetJSON<T>(keys: string[]): Promise<(T | undefined)[]> {
    if (keys.length === 0) return [];
    const r = await cmd<(string | null)[]>(["MGET", ...keys]);
    return r.map((s) => (s ? (JSON.parse(s) as T) : undefined));
  },
};
