// PosteAhora MCP server — Streamable HTTP transport (EXPERIMENTAL).
//
// Remote/hosted mode for connectors that speak MCP over HTTP (e.g. ChatGPT,
// web agents). Runs statelessly: each POST /mcp builds a fresh server instance.
//
// Multi-tenant: the per-request `Authorization: Bearer <pah_…>` header is used
// as the caller's API key, falling back to POSTEAHORA_API_KEY for single-tenant
// deploys. A production deployment should add OAuth (DCR) in front of this —
// tracked as a follow-up.

import http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { PosteAhoraClient } from "./client.js";
import { registerTools } from "./tools.js";

const baseUrl = process.env.POSTEAHORA_API_URL;
const port = Number(process.env.PORT ?? "8787");
const fallbackKey = process.env.POSTEAHORA_API_KEY;

if (!baseUrl) {
  console.error(
    "Missing POSTEAHORA_API_URL (e.g. https://<project-ref>.supabase.co/functions/v1/api).",
  );
  process.exit(1);
}

function resolveKey(req: http.IncomingMessage): string | undefined {
  const auth = req.headers["authorization"];
  if (typeof auth === "string" && /^Bearer\s+/i.test(auth)) {
    return auth.replace(/^Bearer\s+/i, "").trim();
  }
  return fallbackKey;
}

const httpServer = http.createServer(async (req, res) => {
  if (req.method !== "POST" || !req.url?.startsWith("/mcp")) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found. POST /mcp" }));
    return;
  }

  const apiKey = resolveKey(req);
  if (!apiKey) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Missing API key (Authorization: Bearer pah_…)" }));
    return;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  let body: unknown;
  try {
    body = raw ? JSON.parse(raw) : undefined;
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid JSON body" }));
    return;
  }

  const server = new McpServer({ name: "posteahora", version: "0.1.0" });
  registerTools(server, new PosteAhoraClient({ baseUrl: baseUrl!, auth: { apiKey } }));

  // Stateless: no session id generator.
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, body);
});

httpServer.listen(port, () => {
  console.error(`PosteAhora MCP server (HTTP) listening on :${port}/mcp`);
});
