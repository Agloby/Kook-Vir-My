import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.110.5";

const ALLOWED_ORIGINS = ["https://kookvirjou.com", "https://www.kookvirjou.com"];
const NETLIFY_SITE_RE = /^https:\/\/([a-z0-9-]+--)?kookvirmy\.netlify\.app$/i;
const ALLOWED_MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_IMAGE_BYTES = 4_000_000;
const MAX_BODY_BYTES = 5_500_000;
const REQUEST_TIMEOUT_MS = 60_000;

function originAllowed(req: Request) { const o = req.headers.get("origin"); return !o || ALLOWED_ORIGINS.includes(o) || NETLIFY_SITE_RE.test(o) || o === "http://localhost:8888"; }
function corsHeaders(req: Request) { const o = req.headers.get("origin") || ""; return { "Access-Control-Allow-Origin": originAllowed(req) && o ? o : ALLOWED_ORIGINS[0], "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS", "Vary": "Origin" }; }
function json(req: Request, body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders(req), "Content-Type": "application/json", "Cache-Control": "no-store" } }); }

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(req) });
  if (req.method !== "POST") return json(req, { error: "Method not allowed." }, 405);
  if (!originAllowed(req)) return json(req, { error: "Origin not allowed." }, 403);
  try {
    const authHeader = req.headers.get("authorization");
    if (!authHeader?.startsWith("Bearer ")) return json(req, { error: "Authentication required." }, 401);
    const supabaseUrl = Deno.env.get("SUPABASE_URL"), anonKey = Deno.env.get("SUPABASE_ANON_KEY"), apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!supabaseUrl || !anonKey || !apiKey) return json(req, { error: "Server configuration is incomplete." }, 503);
    const client = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
    const { data: authData, error: authError } = await client.auth.getUser();
    if (authError || !authData.user) return json(req, { error: "Authentication required." }, 401);
    const length = Number(req.headers.get("content-length") || 0);
    if (length > MAX_BODY_BYTES) return json(req, { error: "Image request is too large." }, 413);
    const raw = await req.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) return json(req, { error: "Image request is too large." }, 413);
    let body: Record<string, unknown>; try { body = JSON.parse(raw); } catch { return json(req, { error: "Invalid JSON request body." }, 400); }
    const { imageBase64, mediaType } = body;
    if (typeof imageBase64 !== "string" || typeof mediaType !== "string" || !ALLOWED_MEDIA_TYPES.has(mediaType)) return json(req, { error: "Use a JPEG, PNG, or WebP image." }, 400);
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(imageBase64)) return json(req, { error: "Image data is invalid." }, 400);
    const decodedBytes = Math.floor(imageBase64.length * 3 / 4) - (imageBase64.endsWith("==") ? 2 : imageBase64.endsWith("=") ? 1 : 0);
    if (decodedBytes <= 0 || decodedBytes > MAX_IMAGE_BYTES) return json(req, { error: "Image must be no larger than 4 MB." }, 413);
    const { data: quota, error: quotaError } = await client.rpc("consume_ai_quota", { p_kind: "photo" });
    if (quotaError) return json(req, { error: "Usage allowance could not be checked." }, 503);
    const allowance = Array.isArray(quota) ? quota[0] : quota;
    if (!allowance?.allowed) return json(req, { error: "Daily photo-scan limit reached. Please try again tomorrow." }, 429);

    const prompt = `Identify distinct grocery items in this pantry photo. Return only JSON: {"items":[{"name":string,"estimatedQuantity":string,"unit":string,"expiryDateGuess":string|null,"confidence":"high"|"medium"|"low"}]}. Only use an ISO expiry date when clearly readable; otherwise null. Use low confidence for ambiguous items. Return an empty items array when nothing useful is identifiable.`;
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let response: Response;
    try { response = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", signal: controller.signal, headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" }, body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 2000, messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: mediaType, data: imageBase64 } }, { type: "text", text: prompt }] }] }) }); }
    finally { clearTimeout(timeout); }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return json(req, { error: "Photo scanning is temporarily unavailable." }, 502);
    return json(req, data);
  } catch (err) {
    const timedOut = err instanceof DOMException && err.name === "AbortError";
    return json(req, { error: timedOut ? "Photo scanning timed out. Please try again." : "Photo scanning failed." }, 502);
  }
});
