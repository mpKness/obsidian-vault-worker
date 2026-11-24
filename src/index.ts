import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";
import type { Env } from "./env";
import { GitHubHandler } from "./github-handler";
import { buildServer } from "./mcp";
import { Vault, cleanPath, parseList } from "./vault";

function vaultFor(env: Env) {
  let prefix = env.VAULT_PREFIX ? cleanPath(env.VAULT_PREFIX) : "";
  if (prefix) prefix += "/";
  const writeAllow = parseList(env.WRITE_ALLOW_PREFIXES);
  const stagingPrefix = cleanPath(env.STAGING_PREFIX || "_Staging");
  const vault = new Vault({
    bucket: env.VAULT,
    history: env.HISTORY,
    prefix,
    readAllow: parseList(env.READ_ALLOW_PREFIXES),
    writeAllow,
    stagingPrefix,
    maxFileBytes: 2 * 1024 * 1024,
  });
  return { vault, writeAllow, stagingPrefix };
}

// Authenticated MCP endpoint. OAuthProvider only lets requests through here
// once they carry a valid access token issued after GitHub login.
export const McpApi: ExportedHandler<Env> = {
  fetch(request, env, ctx) {
    const { vault, writeAllow, stagingPrefix } = vaultFor(env);
    const handler = createMcpHandler(() => buildServer(vault, writeAllow, stagingPrefix), {
      route: "/mcp",
      allowedHostnames: [new URL(env.PUBLIC_URL).hostname, "localhost", "127.0.0.1"],
    });
    return handler(request, env, ctx);
  },
};

// The provider needs this server's public URL, which lives in env, so build it
// on first request and reuse it.
let provider: OAuthProvider<Env> | undefined;

export default {
  fetch(request, env, ctx) {
    provider ??= new OAuthProvider<Env>({
      apiRoute: "/mcp",
      apiHandler: McpApi as any,
      defaultHandler: GitHubHandler as any,
      authorizeEndpoint: "/authorize",
      tokenEndpoint: "/token",
      clientRegistrationEndpoint: "/register",
      clientIdMetadataDocumentEnabled: true,
      resourceMetadata: {
        resource: new URL("/mcp", env.PUBLIC_URL).href,
        authorization_servers: [new URL(env.PUBLIC_URL).origin],
        resource_name: "Obsidian vault",
      },
    });
    return provider.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
