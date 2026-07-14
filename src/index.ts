#!/usr/bin/env node
// PosteAhora MCP server — stdio transport.
//
// Default entry point for local AI agents (Claude Code, Cursor, Windsurf).
// Configure with two env vars:
//   POSTEAHORA_API_KEY  — a `pah_…` key minted in Settings → API & integrations
//   POSTEAHORA_API_URL  — https://<project-ref>.supabase.co/functions/v1/api

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { PosteAhoraClient } from "./client.js";
import { registerTools } from "./tools.js";

const apiKey = process.env.POSTEAHORA_API_KEY;
const baseUrl = process.env.POSTEAHORA_API_URL;

if (!apiKey) {
  console.error("Missing POSTEAHORA_API_KEY environment variable.");
  process.exit(1);
}
if (!baseUrl) {
  console.error(
    "Missing POSTEAHORA_API_URL (e.g. https://<project-ref>.supabase.co/functions/v1/api).",
  );
  process.exit(1);
}

const server = new McpServer({ name: "posteahora", version: "0.1.0" });
registerTools(server, new PosteAhoraClient({ baseUrl, auth: { apiKey } }));

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("PosteAhora MCP server running on stdio");
