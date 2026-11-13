import { NextResponse, type NextRequest } from "next/server";
import { MARKET_API } from "@/lib/muse/catalog";
import { MCP_SERVER_INFO, MCP_URL, handleMessage } from "@/lib/mcp/server";

/**
 * Port66's MCP server over streamable HTTP, stateless.
 *
 * POST one JSON-RPC message and get one JSON answer (or 202 for a
 * notification). There are no sessions and no server-to-client stream, so
 * GET returns 405 as the transport allows. Tools are defined in
 * lib/mcp/server.ts.
 *
 *   claude mcp add --transport http port66 https://port66.xyz/api/mcp
 */

// A price check waits on NEAR Intents solvers (up to 20s) after a listing
// lookup, so allow more than the 30s default.
export const maxDuration = 60;

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, GET, OPTIONS",
  "access-control-allow-headers":
    "content-type, authorization, mcp-protocol-version, mcp-session-id, accept",
};

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
      { status: 400, headers: CORS },
    );
  }
  const ctx = { api: MARKET_API, authorization: req.headers.get("authorization") };

  // Older clients may batch; answer each message in order.
  if (Array.isArray(body)) {
    const answers = (await Promise.all(body.map((m) => handleMessage(m, ctx)))).filter(Boolean);
    return answers.length
      ? NextResponse.json(answers, { headers: CORS })
      : new NextResponse(null, { status: 202, headers: CORS });
  }
  const answer = await handleMessage(body, ctx);
  return answer
    ? NextResponse.json(answer, { headers: CORS })
    : new NextResponse(null, { status: 202, headers: CORS });
}

/** No server-to-client stream; a GET describes the server for humans. */
export function GET() {
  return NextResponse.json(
    {
      ...MCP_SERVER_INFO,
      transport: "streamable-http (stateless, POST only)",
      url: MCP_URL,
      connect: `claude mcp add --transport http port66 ${MCP_URL}`,
      docs: "https://port66.xyz/llms.txt",
    },
    { status: 405, headers: { ...CORS, allow: "POST, OPTIONS" } },
  );
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}
