import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import {
  buildPepestoInput,
  isRetailerDomain,
  normalisePepestoResponse,
  type ShoppingItem,
} from "./helpers.ts";

const ALLOWED_ORIGINS = ["https://kookvirjou.com", "https://www.kookvirjou.com"];
const MAX_BODY_BYTES = 2048;
const PEPESTO_ENDPOINT = "https://s.pepesto.com/api/products";
// Some retailer caches respond more slowly than others. Keep one billable call,
// but allow enough time for the slower Irish retailer response to complete.
const REQUEST_TIMEOUT_MS = 45_000;

// Only this project's own Netlify site (production alias + deploy/branch previews) -
// origin.endsWith(".netlify.app") would accept any Netlify-hosted site, not just this one.
const NETLIFY_SITE_RE = /^https:\/\/([a-z0-9-]+--)?kookvirmy\.netlify\.app$/i;
// Each comparison is a billable Pepesto call per retailer; this only guards against rapid
// repeat clicks on the same list, it is not a full per-household rate limiter.
const COMPARE_COOLDOWN_MS = 10_000;

function corsHeaders(req: Request) {
  const origin = req.headers.get("origin") || "";
  const allowed = ALLOWED_ORIGINS.includes(origin) || NETLIFY_SITE_RE.test(origin) ||
    origin === "http://localhost:8888" || origin === "http://localhost:8000";
  return {
    "Access-Control-Allow-Origin": allowed ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function json(req: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function cleanError(status: number): string {
  if (status === 401 || status === 403) return "Pepesto authentication failed.";
  if (status === 402) return "Pepesto credits are unavailable.";
  if (status === 429) return "Pepesto is temporarily rate-limiting requests.";
  return "Pepesto could not complete this comparison.";
}

export async function callPepesto(apiKey: string, contentText: string, retailerDomain: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(PEPESTO_ENDPOINT, {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        recipe_kg_tokens: [],
        manual_shopping_list: contentText,
        supermarket_domain: retailerDomain,
        item_names_locale: "en-IE",
      }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(cleanError(response.status));
    return await response.json() as Record<string, unknown>;
  } finally {
    clearTimeout(timeout);
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(req) });
  if (req.method !== "POST") return json(req, { error: "Method not allowed." }, 405);

  try {
    const contentLength = Number(req.headers.get("content-length") || 0);
    if (contentLength > MAX_BODY_BYTES) return json(req, { error: "Request body is too large." }, 413);
    const rawBody = await req.text();
    if (new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES) {
      return json(req, { error: "Request body is too large." }, 413);
    }
    let body: Record<string, unknown>;
    try { body = JSON.parse(rawBody); } catch { return json(req, { error: "Invalid JSON request body." }, 400); }

    const { shoppingListId, retailerDomain, mode } = body;
    if (typeof shoppingListId !== "string" || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(shoppingListId) ||
      !isRetailerDomain(retailerDomain) || mode !== "compare") {
      return json(req, { error: "Invalid shopping list, retailer, or mode." }, 400);
    }

    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) return json(req, { error: "Authentication required." }, 401);
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    if (!supabaseUrl || !anonKey) return json(req, { error: "Server configuration is incomplete." }, 500);
    const client = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
    const { data: authData, error: authError } = await client.auth.getUser();
    if (authError || !authData.user) return json(req, { error: "Authentication required." }, 401);

    const { data: list, error: listError } = await client.from("shopping_lists")
      .select("id, household_id, pepesto_last_compared_at").eq("id", shoppingListId).maybeSingle();
    if (listError || !list) return json(req, { error: "Shopping list not found." }, 404);
    const { data: membership } = await client.from("household_members").select("household_id")
      .eq("household_id", list.household_id).eq("user_id", authData.user.id).maybeSingle();
    if (!membership) return json(req, { error: "You do not have access to this shopping list." }, 403);

    if (list.pepesto_last_compared_at) {
      const elapsedMs = Date.now() - new Date(list.pepesto_last_compared_at as string).getTime();
      if (elapsedMs < COMPARE_COOLDOWN_MS) {
        return json(req, { error: "Please wait a few seconds before comparing this list again." }, 429);
      }
    }

    const { data: items, error: itemsError } = await client.from("shopping_list_items")
      .select("item_name, quantity, unit, quantity_text, notes, status")
      .eq("shopping_list_id", list.id).eq("household_id", list.household_id).order("sort_order");
    if (itemsError) return json(req, { error: "Shopping-list items could not be loaded." }, 500);
    const contentText = buildPepestoInput((items || []) as ShoppingItem[]);
    if (!contentText) return json(req, { error: "This list has no required items to compare." }, 400);
    if (contentText.length > 5000) return json(req, { error: "The shopping list is too long for comparison." }, 400);

    const apiKey = Deno.env.get("PEPESTO_API_KEY");
    if (!apiKey) return json(req, { error: "Pepesto is not configured on this project." }, 503);
    const upstream = await callPepesto(apiKey, contentText, retailerDomain);
    await client.from("shopping_lists").update({ pepesto_last_compared_at: new Date().toISOString() })
      .eq("id", list.id);
    return json(req, normalisePepestoResponse(upstream, retailerDomain));
  } catch (error) {
    const message = error instanceof DOMException && error.name === "AbortError"
      ? "Pepesto timed out. Please try again."
      : (error instanceof Error && error.message.startsWith("Pepesto ")
        ? error.message
        : "The comparison could not be completed.");
    return json(req, { error: message }, 502);
  }
});
