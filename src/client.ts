// Thin fetch wrapper around the PosteAhora public REST API. The MCP server
// never touches the database directly — it calls the same `api/` gateway that
// enforces auth, quota and ownership.
//
// Two auth modes:
//  - key:    local stdio server → Authorization: Bearer pah_… (a user's key)
//  - bridge: hosted remote server → X-MCP-Bridge-Secret + X-MCP-User-Id, after
//            it resolved the user from their connector token.

export type PosteAhoraAuth =
  | { apiKey: string }
  | { bridgeSecret: string; userId: string };

export interface PosteAhoraClientOptions {
  baseUrl: string;
  auth: PosteAhoraAuth;
}

export class PosteAhoraClient {
  private baseUrl: string;
  private authHeaders: Record<string, string>;

  constructor({ baseUrl, auth }: PosteAhoraClientOptions) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.authHeaders = "apiKey" in auth
      ? { Authorization: `Bearer ${auth.apiKey}` }
      : { "X-MCP-Bridge-Secret": auth.bridgeSecret, "X-MCP-User-Id": auth.userId };
  }

  private async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { ...this.authHeaders, "Content-Type": "application/json" },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const text = await res.text();
    let data: unknown = undefined;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text };
      }
    }

    if (!res.ok) {
      const msg = (data && typeof data === "object" && "error" in data)
        ? String((data as { error: unknown }).error)
        : `HTTP ${res.status}`;
      throw new Error(msg);
    }

    return data as T;
  }

  get<T = unknown>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }

  post<T = unknown>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("POST", path, body);
  }

  patch<T = unknown>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("PATCH", path, body);
  }

  del<T = unknown>(path: string): Promise<T> {
    return this.request<T>("DELETE", path);
  }
}
