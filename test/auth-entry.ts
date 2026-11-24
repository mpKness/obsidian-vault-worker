// Local-only harness: the real Worker with GitHub's endpoints stubbed, to test
// the OAuth flow end to end. Never deploy this.
import worker from "../src/index";
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith("https://github.com/login/oauth/access_token")) {
    const body = JSON.parse(String(init?.body));
    if (body.code !== "good-code" || !body.code_verifier) return Response.json({ error_description: "bad code" });
    return Response.json({ access_token: "gh-token" });
  }
  if (url.startsWith("https://api.github.com/user")) {
    return Response.json({ login: (globalThis as any).__ghLogin ?? "mpKness", id: 42 });
  }
  return realFetch(input as any, init);
}) as typeof fetch;
export default {
  fetch(req: Request, env: any, ctx: ExecutionContext) {
    const u = new URL(req.url);
    if (u.searchParams.get("as")) (globalThis as any).__ghLogin = u.searchParams.get("as");
    return worker.fetch(req, env, ctx);
  },
};
