/**
 * The agent's language layer: read a shopping task, and write the reasoning
 * on a counter-offer. Nothing here decides whether money moves (that is
 * mandate.ts), so a wrong or missing model can make the agent less articulate
 * but never less safe.
 *
 * With NEAR_AI_API_KEY and NEAR_AI_MODEL set it uses NEAR AI Cloud, an
 * OpenAI-compatible endpoint. Without them it falls back to plain rules, so
 * the agent runs end to end with no AI account at all.
 */

export interface Task {
  query: string;
  maxUsd?: number;
}

const FILLER =
  /\b(find|get|buy|me|a|an|the|some|for|please|i|want|need|looking|pay|with|from|in|on)\b/gi;
const PRICE =
  /(?:under|below|less than|max(?:imum)?|up to|<=?|budget(?: of)?)\s*\$?\s*(\d+(?:\.\d+)?)|\$\s*(\d+(?:\.\d+)?)/i;

/** Rule-based reading of "a KAWS figure under $300" -> {query, maxUsd}. */
export function parseTaskRules(task: string): Task {
  const match = task.match(PRICE);
  const parsed = match ? Number(match[1] ?? match[2]) : undefined;
  // "$300" inside double quotes is expanded by the shell before the agent sees
  // it ("$3" + "00"), so a zero or missing figure means "no ceiling given",
  // and the owner's own limit applies.
  const maxUsd = parsed && parsed > 0 ? parsed : undefined;
  const query = task
    .replace(PRICE, " ")
    .replace(/\b(sol|solana|btc|bitcoin|eth|near|usdc)\b/gi, " ")
    .replace(FILLER, " ")
    .replace(/[^\w\s'-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return { query: query || task.trim(), maxUsd };
}

interface ChatConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
}

function chatConfig(): ChatConfig | null {
  const apiKey = process.env.NEAR_AI_API_KEY?.trim();
  const model = process.env.NEAR_AI_MODEL?.trim();
  if (!apiKey || !model) return null;
  return {
    apiKey,
    model,
    baseUrl: (process.env.NEAR_AI_BASE_URL ?? "https://cloud-api.near.ai/v1").replace(/\/+$/, ""),
  };
}

async function chat(config: ChatConfig, system: string, user: string): Promise<string> {
  const res = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      temperature: 0.2,
      max_tokens: 300,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`NEAR AI returned HTTP ${res.status}`);
  const json = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const text = json.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("NEAR AI returned no text");
  return text;
}

export function brainName(): string {
  const c = chatConfig();
  return c ? `NEAR AI Cloud (${c.model})` : "built-in rules (set NEAR_AI_API_KEY and NEAR_AI_MODEL to use NEAR AI)";
}

/** Read the task. A model's reading is only used if it parses cleanly. */
export async function readTask(task: string): Promise<Task> {
  const rules = parseTaskRules(task);
  const config = chatConfig();
  if (!config) return rules;
  try {
    const text = await chat(
      config,
      'Extract a marketplace search from a shopping request. Reply with JSON only: {"query": string, "maxUsd": number | null}. "query" is 1-5 search words (brand, item). "maxUsd" is the stated price ceiling in USD, or null.',
      task,
    );
    const parsed = JSON.parse(text.replace(/^```(?:json)?|```$/g, "").trim()) as {
      query?: unknown;
      maxUsd?: unknown;
    };
    const query = typeof parsed.query === "string" ? parsed.query.trim() : "";
    const maxUsd =
      typeof parsed.maxUsd === "number" && parsed.maxUsd > 0 ? parsed.maxUsd : rules.maxUsd;
    return query ? { query, maxUsd } : rules;
  } catch {
    return rules;
  }
}

/** The message sent with a counter-offer. */
export async function counterMessage(input: {
  title: string;
  listedUsd: number;
  offerUsd: number;
  ceilingUsd: number;
}): Promise<string> {
  const fallback =
    `Hi, I'm a buying agent shopping for my owner. I'd like ${input.title}, but my owner's ` +
    `ceiling for this item is $${input.ceilingUsd.toFixed(2)}, so I can offer ` +
    `$${input.offerUsd.toFixed(2)} against the listed $${input.listedUsd.toFixed(2)}. ` +
    `If you accept, I'll pay straight away through Port66 and the USDC lands in your wallet.`;
  const config = chatConfig();
  if (!config) return fallback;
  try {
    const text = await chat(
      config,
      "You write one short, polite counter-offer message (under 60 words) from an AI buying agent to a seller on a resale marketplace. State the offer, give the owner's budget ceiling as the reason, and say payment is immediate on acceptance. No placeholders, no sign-off.",
      `Item: ${input.title}. Listed: $${input.listedUsd.toFixed(2)}. Offer: $${input.offerUsd.toFixed(2)}. Owner's ceiling: $${input.ceilingUsd.toFixed(2)}.`,
    );
    return text.length > 600 ? fallback : text;
  } catch {
    return fallback;
  }
}
