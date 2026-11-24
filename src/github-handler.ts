// Browser-facing half of the Worker: the OAuth consent page and GitHub login.
// Claude (the MCP client) registers itself, sends Michael here to approve,
// we confirm he's an allowed GitHub user, then hand Claude a token.

import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { AuthorizationError, authorizationErrorRedirect } from "@cloudflare/workers-oauth-provider";
import type { Env } from "./env";

type HandlerEnv = Env & { OAUTH_PROVIDER: OAuthHelpers };

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function page(title: string, body: string, status = 200, headers = new Headers()): Response {
  headers.set("Content-Type", "text/html; charset=utf-8");
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:28rem;margin:4rem auto;padding:0 1rem;line-height:1.5}
button{font:inherit;padding:.6rem 1.2rem;border-radius:.4rem;border:1px solid #888;cursor:pointer;margin-right:.5rem}
.primary{background:#1f6feb;color:#fff;border-color:#1f6feb}code{background:#eee;padding:.1rem .3rem;border-radius:.2rem}</style>
</head><body>${body}</body></html>`,
    { status, headers },
  );
}

function errorResponse(e: unknown): Response {
  if (e instanceof AuthorizationError && e.redirectTo) return Response.redirect(e.redirectTo, 302);
  const msg = e instanceof Error ? e.message : String(e);
  return page("Error", `<h1>Something went wrong</h1><p>${esc(msg)}</p>`, 400);
}

async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function showConsent(request: Request, env: HandlerEnv): Promise<Response> {
  const authReq = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  const info = await env.OAUTH_PROVIDER.describeConsent(authReq);
  const { handle, headers } = await env.OAUTH_PROVIDER.beginConsent(authReq);
  return page(
    "Connect to your vault",
    `<h1>Connect to your Obsidian vault?</h1>
<p><strong>${esc(info.clientName)}</strong>${info.clientDomain ? ` (${esc(info.clientDomain)})` : ""} wants to read and write your vault notes.</p>
<p>Tokens will be sent to <code>${esc(info.redirectHost)}</code>. Only approve if you just started connecting Claude.</p>
<form method="post" action="/authorize">
<input type="hidden" name="handle" value="${esc(handle)}">
<button class="primary" name="action" value="approve">Continue with GitHub</button>
<button name="action" value="deny">Cancel</button>
</form>`,
    200,
    headers,
  );
}

async function handleConsent(request: Request, env: HandlerEnv): Promise<Response> {
  const form = await request.formData();
  const handle = String(form.get("handle") ?? "");
  if (form.get("action") !== "approve") {
    const denied = await env.OAUTH_PROVIDER.denyConsent(request, handle);
    return new Response(null, { status: 302, headers: denied.headers });
  }
  const approved = await env.OAUTH_PROVIDER.approveConsent(request, handle);
  const verifier = crypto.randomUUID() + crypto.randomUUID();
  const { state, headers } = await env.OAUTH_PROVIDER.beginUpstream(approved.request, {
    data: { verifier },
    headers: approved.headers,
  });
  const gh = new URL("https://github.com/login/oauth/authorize");
  gh.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  gh.searchParams.set("redirect_uri", new URL("/callback", request.url).href);
  gh.searchParams.set("state", state);
  gh.searchParams.set("allow_signup", "false");
  gh.searchParams.set("code_challenge", await s256(verifier));
  gh.searchParams.set("code_challenge_method", "S256");
  // No scopes: we only need the public profile to learn the username.
  headers.set("Location", gh.href);
  return new Response(null, { status: 302, headers });
}

async function handleCallback(request: Request, env: HandlerEnv): Promise<Response> {
  const resumed = await env.OAUTH_PROVIDER.finishUpstream<{ verifier: string }>(request);
  const authReq: AuthRequest = resumed.request;
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  if (url.searchParams.get("error") || !code) {
    const headers = new Headers(resumed.headers);
    headers.set("Location", authorizationErrorRedirect(authReq, "access_denied"));
    return new Response(null, { status: 302, headers });
  }

  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      code_verifier: resumed.data.verifier,
      redirect_uri: new URL("/callback", request.url).href,
    }),
  });
  const token = (await tokenRes.json()) as { access_token?: string; error_description?: string };
  if (!token.access_token) throw new Error(`GitHub token exchange failed: ${token.error_description ?? tokenRes.status}`);

  const userRes = await fetch("https://api.github.com/user", {
    headers: { Authorization: `Bearer ${token.access_token}`, "User-Agent": "obsidian-vault-worker", Accept: "application/vnd.github+json" },
  });
  if (!userRes.ok) throw new Error(`GitHub user lookup failed: ${userRes.status}`);
  const user = (await userRes.json()) as { login: string; id: number };

  const allowed = (env.ALLOWED_GITHUB_USERS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!allowed.includes(user.login.toLowerCase())) {
    return page("Not allowed", `<h1>Access denied</h1><p>GitHub user <code>${esc(user.login)}</code> isn't allowed to use this vault.</p>`, 403, resumed.headers);
  }

  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: authReq,
    userId: String(user.id),
    metadata: { label: user.login },
    scope: authReq.scope,
    props: { login: user.login },
  });
  const headers = new Headers(resumed.headers);
  headers.set("Location", redirectTo);
  return new Response(null, { status: 302, headers });
}

export const GitHubHandler: ExportedHandler<HandlerEnv> = {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/authorize" && request.method === "GET") return await showConsent(request, env);
      if (url.pathname === "/authorize" && request.method === "POST") return await handleConsent(request, env);
      if (url.pathname === "/callback") return await handleCallback(request, env);
      if (url.pathname === "/") return page("Obsidian vault MCP", "<h1>Obsidian vault MCP server</h1><p>Add <code>/mcp</code> on this host as a custom connector in Claude.</p>");
      return new Response("Not found", { status: 404 });
    } catch (e) {
      return errorResponse(e);
    }
  },
};
