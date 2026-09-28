import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PosteAhoraClient } from "./client.js";

type ToolResult = {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

function ok(data: unknown): ToolResult {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  const structuredContent =
    data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : { value: data };
  return { content: [{ type: "text", text }], structuredContent };
}

function fail(err: unknown): ToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

const CONTENT_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
  ".webp": "image/webp", ".gif": "image/gif", ".mp4": "video/mp4",
  ".mov": "video/quicktime", ".webm": "video/webm", ".m4v": "video/x-m4v",
};

const accountMappingSchema = z.object({
  platform: z.string().describe("Platform id, e.g. instagram, twitter, linkedin, threads, facebook, tiktok, youtube, pinterest"),
  accountId: z.string().describe("connected_accounts.id from list_accounts for this platform"),
});

// Loose output shapes (passthrough keeps extra fields the API may add). Used as
// outputSchema so MCP clients (e.g. ChatGPT) get structured, typed results.
const accountShape = z.object({
  id: z.string(),
  platform: z.string(),
  platform_username: z.string().nullable().optional(),
  is_connected: z.boolean().optional(),
}).passthrough();

const ideaShape = z.object({
  id: z.string(),
  title: z.string().nullable().optional(),
  caption: z.string().nullable().optional(),
  status: z.string().optional(),
  tags: z.array(z.string()).optional(),
}).passthrough();

const postShape = z.object({
  id: z.string(),
  status: z.string().optional(),
  platforms: z.array(z.string()).optional(),
}).passthrough();

export function registerTools(server: McpServer, client: PosteAhoraClient): void {
  // --- Discovery -----------------------------------------------------------
  server.registerTool(
    "list_accounts",
    {
      title: "List connected social accounts",
      outputSchema: { accounts: z.array(accountShape) },
      annotations: { readOnlyHint: true, openWorldHint: true },
      description:
        "List the connected social accounts in this key/connector's workspace (a key or connector is bound to one workspace, so this returns that workspace's accounts, not every account you own). ALWAYS call this first before create_post or schedule_post: you need each account's `id` to target the right channel (the API refuses to publish without an explicit accountId).",
      inputSchema: {},
    },
    async () => {
      try {
        return ok(await client.get("/accounts"));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "list_boards",
    {
      title: "List Pinterest boards of a connected account",
      outputSchema: {
        boards: z.array(z.object({
          id: z.string(),
          name: z.string(),
          privacy: z.string(),
          pinCount: z.number().nullable(),
        }).passthrough()),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
      description:
        "List the boards of one connected Pinterest account. A Pin is always created on a board, so call this before create_post / schedule_post to Pinterest and pass the chosen board's `id` as platformOptions.pinterest.boardId.",
      inputSchema: {
        accountId: z.string().describe("connected_accounts.id of a Pinterest account (from list_accounts)"),
      },
    },
    async ({ accountId }) => {
      try {
        return ok(await client.get(`/accounts/${encodeURIComponent(accountId)}/boards`));
      } catch (e) {
        return fail(e);
      }
    },
  );

  // --- Ideas ---------------------------------------------------------------
  server.registerTool(
    "list_ideas",
    {
      title: "List post ideas",
      outputSchema: { ideas: z.array(ideaShape) },
      annotations: { readOnlyHint: true },
      description: "List your workspace's post ideas (the kanban backlog of drafts to iterate on).",
      inputSchema: {},
    },
    async () => {
      try {
        return ok(await client.get("/ideas"));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "create_idea",
    {
      title: "Create a post idea",
      outputSchema: { idea: ideaShape },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      description:
        "Add a lightweight idea to the backlog. Use this for brainstorming — it does NOT publish anything. Promote to a real post later with create_post.",
      inputSchema: {
        title: z.string().optional().describe("Short title for the idea"),
        caption: z.string().optional().describe("Draft caption / body text"),
        tags: z.array(z.string()).optional().describe("Freeform tags"),
        mediaUrls: z.array(z.string()).optional().describe("Public media URLs (from upload_media)"),
        status: z.enum(["unassigned", "todo", "in_progress", "done"]).optional()
          .describe("Kanban column; defaults to unassigned"),
      },
    },
    async (args) => {
      try {
        return ok(await client.post("/ideas", args));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "update_idea",
    {
      title: "Update a post idea",
      outputSchema: { idea: ideaShape },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      description:
        "Edit an existing idea in the backlog. Only the fields you pass are changed. Use `status` to move it between kanban columns. Get ids from list_ideas.",
      inputSchema: {
        id: z.string().describe("Idea id (from list_ideas)"),
        title: z.string().optional().describe("Short title for the idea"),
        caption: z.string().optional().describe("Draft caption / body text"),
        tags: z.array(z.string()).optional().describe("Freeform tags (replaces the existing list)"),
        mediaUrls: z.array(z.string()).optional().describe("Public media URLs (replaces the existing list)"),
        status: z.enum(["unassigned", "todo", "in_progress", "done"]).optional()
          .describe("Move the idea to this kanban column"),
        position: z.number().optional().describe("Sort position within the column (fractional indexing)"),
      },
    },
    async ({ id, ...patch }) => {
      try {
        return ok(await client.patch(`/ideas/${encodeURIComponent(id)}`, patch));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "delete_idea",
    {
      title: "Delete a post idea",
      outputSchema: { id: z.string(), deleted: z.boolean() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
      description: "Permanently delete an idea from the backlog. Get ids from list_ideas.",
      inputSchema: {
        id: z.string().describe("Idea id (from list_ideas)"),
      },
    },
    async ({ id }) => {
      try {
        return ok(await client.del(`/ideas/${encodeURIComponent(id)}`));
      } catch (e) {
        return fail(e);
      }
    },
  );

  // --- Posts ---------------------------------------------------------------
  const postInputSchema = {
    caption: z.string().optional().describe("Caption / body text (shared across platforms unless overridden)"),
    title: z.string().optional().describe("Optional title (used by YouTube etc.)"),
    accountMappings: z.array(accountMappingSchema)
      .describe("One entry per channel: which connected account to post to for each platform. Get ids from list_accounts."),
    mediaUrls: z.array(z.string()).optional().describe("Public media URLs (upload local files via upload_media first)"),
    mediaType: z.enum(["image", "video"]).optional()
      .describe("Media kind. Strongly recommended for TikTok: it decides the video vs photo endpoint. If omitted it's inferred from the first mediaUrl's extension, but pass it explicitly to be safe."),
    postType: z.enum(["post", "reel", "story"]).optional()
      .describe("Defaults to 'post'. Pass 'reel' for videos (feed video vs Reel on Facebook/Instagram). TikTok routes by mediaType (falling back to the media URL extension), not postType."),
    hashtags: z.array(z.string()).optional(),
    platformCaptions: z.record(z.string(), z.string()).optional()
      .describe("Per-platform caption overrides, keyed by platform id"),
    platformOptions: z.record(z.string(), z.unknown()).optional()
      .describe("Per-platform options, keyed by platform id (e.g. { tiktok: {...}, instagram: {...} }). Pinterest REQUIRES a board: set pinterest.boardId to a board id from list_boards (optional pinterest.title up to 100 chars, pinterest.link, pinterest.altText). A Pin needs media: 1 image, 2-5 images (carousel) or 1 video."),
  };

  server.registerTool(
    "create_post",
    {
      title: "Create or publish a post",
      outputSchema: { postIds: z.array(z.string()), status: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      description:
        "Create a post. With status 'draft' it's saved only. With status 'published' it is published immediately to every channel in accountMappings. ALWAYS call list_accounts first to get accountId for each platform. Upload media via upload_media and pass the returned public URL in mediaUrls.",
      inputSchema: {
        ...postInputSchema,
        status: z.enum(["draft", "published"]).optional().describe("Defaults to 'draft'. Use 'published' to post now."),
      },
    },
    async (args) => {
      try {
        return ok(await client.post("/posts", { ...args, status: args.status ?? "draft" }));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "schedule_post",
    {
      title: "Schedule a post for later",
      outputSchema: { postIds: z.array(z.string()), status: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      description:
        "Schedule a post to publish at a future time. Same as create_post but requires scheduledAt (ISO 8601). Call list_accounts first.",
      inputSchema: {
        ...postInputSchema,
        scheduledAt: z.string().describe("When to publish, ISO 8601 (e.g. 2026-06-01T14:30:00Z). Must be in the future."),
      },
    },
    async (args) => {
      try {
        return ok(await client.post("/posts", { ...args, status: "scheduled" }));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "update_post",
    {
      title: "Update an existing post",
      outputSchema: { post: postShape },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      description:
        "Edit a draft or scheduled post. Only the fields you pass are changed. Status can be 'draft' or 'scheduled' (with scheduledAt) — to publish an existing post immediately use publish_post_now instead. Get ids from list_posts.",
      inputSchema: {
        id: z.string().describe("Post id (from list_posts)"),
        caption: z.string().optional(),
        title: z.string().optional(),
        hashtags: z.array(z.string()).optional(),
        mediaUrls: z.array(z.string()).optional().describe("Public media URLs (replaces the existing list)"),
        mediaType: z.enum(["image", "video"]).optional(),
        postType: z.enum(["post", "reel", "story"]).optional(),
        platforms: z.array(z.string()).optional().describe("Platform ids this post targets"),
        connectedAccountId: z.string().optional().describe("connected_accounts.id to target (from list_accounts)"),
        platformOptions: z.record(z.string(), z.unknown()).optional()
          .describe("Per-platform options, keyed by platform id. Pinterest REQUIRES a board: set pinterest.boardId to a board id from list_boards (optional pinterest.title up to 100 chars, pinterest.link, pinterest.altText). A Pin needs media: 1 image, 2-5 images (carousel) or 1 video."),
        status: z.enum(["draft", "scheduled"]).optional(),
        scheduledAt: z.string().optional().describe("When to publish, ISO 8601. Required-in-future when status is 'scheduled'."),
      },
    },
    async ({ id, ...patch }) => {
      try {
        return ok(await client.patch(`/posts/${encodeURIComponent(id)}`, patch));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "delete_post",
    {
      title: "Delete a post",
      outputSchema: { id: z.string(), deleted: z.boolean() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
      description: "Delete a post (soft delete — it stops appearing in listings). Get ids from list_posts.",
      inputSchema: {
        id: z.string().describe("Post id (from list_posts)"),
      },
    },
    async ({ id }) => {
      try {
        return ok(await client.del(`/posts/${encodeURIComponent(id)}`));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "publish_post_now",
    {
      title: "Publish an existing post now",
      outputSchema: { postIds: z.array(z.string()), status: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      description:
        "Publish a saved draft or scheduled post immediately to its channels. A multi-channel draft is fanned out into one post per platform (each returned in postIds); the original draft id is retired. The post must already have a connected account selected per channel (set it with update_post if needed). Use get_post_status on the returned ids to check the per-platform result.",
      inputSchema: {
        id: z.string().describe("Post id (from list_posts)"),
      },
    },
    async ({ id }) => {
      try {
        return ok(await client.post(`/posts/${encodeURIComponent(id)}/publish`));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "list_posts",
    {
      title: "List posts",
      outputSchema: { posts: z.array(postShape) },
      annotations: { readOnlyHint: true },
      description: "List your workspace's posts, newest first. Optionally filter by status.",
      inputSchema: {
        status: z.enum(["draft", "scheduled", "queued", "published", "partial_published", "failed"]).optional(),
        limit: z.number().int().min(1).max(200).optional().describe("Max rows (default 50)"),
      },
    },
    async (args) => {
      try {
        const params = new URLSearchParams();
        if (args.status) params.set("status", args.status);
        if (args.limit) params.set("limit", String(args.limit));
        const qs = params.toString();
        return ok(await client.get(`/posts${qs ? `?${qs}` : ""}`));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "get_post_status",
    {
      title: "Get a post's status",
      outputSchema: { post: postShape },
      annotations: { readOnlyHint: true },
      description: "Fetch one post by id, including its per-platform publish results (platform_results).",
      inputSchema: {
        id: z.string().describe("Post id"),
      },
    },
    async ({ id }) => {
      try {
        return ok(await client.get(`/posts/${encodeURIComponent(id)}`));
      } catch (e) {
        return fail(e);
      }
    },
  );

  // --- Analytics -----------------------------------------------------------
  server.registerTool(
    "get_analytics",
    {
      title: "Get post analytics",
      outputSchema: {
        period: z.string(),
        summary: z.object({
          totals: z.record(z.string(), z.number()),
          byPlatform: z.record(z.string(), z.record(z.string(), z.number())),
        }).passthrough(),
        posts: z.array(z.object({ postId: z.string().optional(), platform: z.string().optional() }).passthrough()),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
      description:
        "Read performance metrics (views, likes, comments, shares, reach, saves, impressions, reposts, interactions) for the user's published posts, with aggregated totals and a per-platform breakdown. Data is synced from each platform hourly. Use it to analyze what performed well and to generate new ideas with create_idea.",
      inputSchema: {
        period: z.enum(["7d", "30d", "90d", "all"]).optional().describe("Window by published date; defaults to 30d"),
        platform: z.string().optional().describe("Filter to a single platform id (e.g. instagram)"),
        limit: z.number().int().min(1).max(500).optional().describe("Max metric rows to scan (default 200)"),
      },
    },
    async (args) => {
      try {
        const params = new URLSearchParams();
        if (args.period) params.set("period", args.period);
        if (args.platform) params.set("platform", args.platform);
        if (args.limit) params.set("limit", String(args.limit));
        const qs = params.toString();
        return ok(await client.get(`/analytics${qs ? `?${qs}` : ""}`));
      } catch (e) {
        return fail(e);
      }
    },
  );

  // --- Media ---------------------------------------------------------------
  server.registerTool(
    "upload_media",
    {
      title: "Upload a media file",
      outputSchema: { publicUrl: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      description:
        "Upload a local image or video file to media storage and get back a public URL to use in mediaUrls of create_post / create_idea. Provide an absolute filePath on the machine running this MCP server.",
      inputSchema: {
        filePath: z.string().describe("Absolute path to the local image/video file"),
        contentType: z.string().optional().describe("MIME type; inferred from the extension when omitted"),
      },
    },
    async ({ filePath, contentType }) => {
      try {
        const bytes = await readFile(filePath);
        const ext = extname(filePath).toLowerCase();
        const type = contentType || CONTENT_TYPES[ext];
        if (!type) {
          return fail(new Error(`Could not infer content type for '${ext}'. Pass contentType explicitly.`));
        }

        const presigned = await client.post<{ uploadUrl: string; publicUrl: string }>(
          "/media/upload-url",
          { filename: basename(filePath), contentType: type, sizeBytes: bytes.byteLength },
        );

        const put = await fetch(presigned.uploadUrl, {
          method: "PUT",
          headers: { "Content-Type": type },
          body: bytes,
        });
        if (!put.ok) {
          return fail(new Error(`Upload failed: HTTP ${put.status}`));
        }

        return ok({ publicUrl: presigned.publicUrl });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "create_upload_url",
    {
      title: "Create a direct media upload URL",
      outputSchema: {
        uploadUrl: z.string(),
        publicUrl: z.string(),
        method: z.string(),
        expiresInSeconds: z.number(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      description:
        "Get a short-lived presigned URL to upload a local media file directly to storage from THIS client. " +
        "Use this instead of upload_media when the MCP server runs remotely and cannot read your local files. " +
        "Steps: (1) call this with filename, sizeBytes (exact byte length of the file) and optionally contentType; " +
        "(2) HTTP PUT the raw file bytes to the returned uploadUrl with header 'Content-Type' set to the same contentType " +
        "(e.g. curl -T ./slide.jpg \"<uploadUrl>\" -H 'Content-Type: image/jpeg') and expect HTTP 200; " +
        "(3) put the returned publicUrl into mediaUrls of create_post / create_idea. " +
        "Do NOT pass a filePath here — you upload the bytes yourself. The uploadUrl expires quickly, so upload right after calling this.",
      inputSchema: {
        filename: z.string().describe("Original filename, e.g. slide-1.jpg — used to derive the extension"),
        contentType: z.string().optional().describe("MIME type; inferred from the filename extension when omitted"),
        sizeBytes: z.number().describe("Exact byte size of the file you will upload"),
      },
    },
    async ({ filename, contentType, sizeBytes }) => {
      try {
        const ext = extname(filename).toLowerCase();
        const type = contentType || CONTENT_TYPES[ext];
        if (!type) {
          return fail(new Error(`Could not infer content type for '${ext}'. Pass contentType explicitly.`));
        }

        const presigned = await client.post<{
          uploadUrl: string;
          publicUrl: string;
          method?: string;
          expiresInSeconds?: number;
        }>("/media/upload-url", { filename, contentType: type, sizeBytes });

        return ok({
          uploadUrl: presigned.uploadUrl,
          publicUrl: presigned.publicUrl,
          method: presigned.method ?? "PUT",
          expiresInSeconds: presigned.expiresInSeconds ?? 300,
        });
      } catch (e) {
        return fail(e);
      }
    },
  );
}
