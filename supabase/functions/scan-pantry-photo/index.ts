import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const ALLOWED_ORIGINS = [
  "https://kookvirjou.com",
  "https://www.kookvirjou.com"
];

function corsHeaders(req: Request) {
  const origin = req.headers.get("origin") || "";
  const isAllowed = ALLOWED_ORIGINS.includes(origin) || origin.endsWith(".netlify.app") || origin === "http://localhost:8888";
  return {
    "Access-Control-Allow-Origin": isAllowed ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin"
  };
}

Deno.serve(async (req: Request) => {
  const CORS_HEADERS = corsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  try {
    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) {
      return new Response(JSON.stringify({ error: "ANTHROPIC_API_KEY secret is not set." }), {
        status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
      });
    }

    const { imageBase64, mediaType } = await req.json();
    if (!imageBase64 || !mediaType) {
      return new Response(JSON.stringify({ error: "Missing imageBase64 or mediaType." }), {
        status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
      });
    }

    const prompt = `Look at this photo of food items, a shelf, fridge, or pantry. List every distinct food/grocery item you can identify. Respond with ONLY valid JSON, no markdown fences, matching this schema:
{"items": [{"name": string, "estimatedQuantity": string, "unit": string, "expiryDateGuess": string|null, "confidence": "high"|"medium"|"low"}]}
Rules:
- estimatedQuantity is your best visual guess (e.g. "1", "half full", "approx 300"), it will be shown to the person as a suggestion they can correct, never present it as exact.
- expiryDateGuess is an ISO date (YYYY-MM-DD) ONLY if you can actually read a printed date in the photo. If you cannot clearly read one, use null, do not guess a plausible-sounding date.
- confidence should be "low" for anything partially obscured, blurry, or ambiguous.
- If you cannot identify anything useful in the image, return {"items": []}.
- Output raw JSON only.`;

    const anthropicResp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 2000,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType, data: imageBase64 } },
            { type: "text", text: prompt }
          ]
        }]
      })
    });

    const data = await anthropicResp.json();
    if (!anthropicResp.ok) {
      return new Response(JSON.stringify({ error: `Anthropic API error: ${anthropicResp.status}`, detail: data }), {
        status: anthropicResp.status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
      });
    }

    return new Response(JSON.stringify(data), { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { ...corsHeaders(req), "Content-Type": "application/json" }
    });
  }
});
