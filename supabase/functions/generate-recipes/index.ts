import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.110.5";

const ALLOWED_ORIGINS = ["https://kookvirjou.com", "https://www.kookvirjou.com"];
const NETLIFY_SITE_RE = /^https:\/\/([a-z0-9-]+--)?kookvirmy\.netlify\.app$/i;
const MAX_BODY_BYTES = 32_000;
const MAX_PROMPT_CHARS = 24_000;
const REQUEST_TIMEOUT_MS = 60_000;

function originAllowed(req: Request) {
  const origin = req.headers.get("origin");
  return !origin || ALLOWED_ORIGINS.includes(origin) || NETLIFY_SITE_RE.test(origin) ||
    origin === "http://localhost:8888";
}
function corsHeaders(req: Request) {
  const origin = req.headers.get("origin") || "";
  return {
    "Access-Control-Allow-Origin": originAllowed(req) && origin ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS", "Vary": "Origin",
  };
}
function json(req: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: {
    ...corsHeaders(req), "Content-Type": "application/json", "Cache-Control": "no-store",
  }});
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(req) });
  if (req.method !== "POST") return json(req, { error: "Method not allowed." }, 405);
  if (!originAllowed(req)) return json(req, { error: "Origin not allowed." }, 403);

  try {
    const authHeader = req.headers.get("authorization");
    if (!authHeader?.startsWith("Bearer ")) return json(req, { error: "Authentication required." }, 401);
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!supabaseUrl || !anonKey || !apiKey) return json(req, { error: "Server configuration is incomplete." }, 503);
    const client = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
    const { data: authData, error: authError } = await client.auth.getUser();
    if (authError || !authData.user) return json(req, { error: "Authentication required." }, 401);

    const contentLength = Number(req.headers.get("content-length") || 0);
    if (contentLength > MAX_BODY_BYTES) return json(req, { error: "Request body is too large." }, 413);
    const rawBody = await req.text();
    if (new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES) return json(req, { error: "Request body is too large." }, 413);
    let body: Record<string, unknown>;
    try { body = JSON.parse(rawBody); } catch { return json(req, { error: "Invalid JSON request body." }, 400); }
    const prompt = body.prompt;
    if (typeof prompt !== "string" || !prompt.trim() || prompt.length > MAX_PROMPT_CHARS) {
      return json(req, { error: "Prompt must be a non-empty string within the allowed size." }, 400);
    }
    const requestedTokens = typeof body.max_tokens === "number" && Number.isFinite(body.max_tokens)
      ? Math.trunc(body.max_tokens) : 4500;
    const maxTokens = Math.max(500, Math.min(8000, requestedTokens));

    const { data: quota, error: quotaError } = await client.rpc("consume_ai_quota", { p_kind: "recipe" });
    if (quotaError) return json(req, { error: "Usage allowance could not be checked." }, 503);
    const allowance = Array.isArray(quota) ? quota[0] : quota;
    if (!allowance?.allowed) return json(req, { error: "Daily recipe-generation limit reached. Please try again tomorrow." }, 429);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let anthropicResp: Response;
    try {
      anthropicResp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST", signal: controller.signal,
        headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: maxTokens,
          messages: [{ role: "user", content: prompt }] }),
      });
    } finally { clearTimeout(timeout); }
    const data = await anthropicResp.json().catch(() => ({}));
    if (!anthropicResp.ok) return json(req, { error: "Recipe generation is temporarily unavailable." }, 502);
    await client.rpc("record_usage_event", { p_category: "recipe_ai", p_cost: 0.03, p_metadata: { model: "claude-sonnet-4-6", max_tokens: maxTokens } }).catch(() => {});
    return json(req, data);
  } catch (err) {
    const timedOut = err instanceof DOMException && err.name === "AbortError";
    console.error(JSON.stringify({event:"recipe_generation_error",timedOut,message:err instanceof Error?err.message:String(err)}));
    return json(req, { error: timedOut ? "Recipe generation timed out. Please try again." : "Recipe generation failed." }, 502);
  }
});
