export const RETAILERS = {
  "tesco.ie": "Tesco Ireland",
  "shop.supervalu.ie": "SuperValu Ireland",
  "dunnesstoresgrocery.com": "Dunnes Stores Grocery",
} as const;

export type RetailerDomain = keyof typeof RETAILERS;

export type ShoppingItem = {
  item_name: string;
  quantity: number | null;
  unit: string | null;
  quantity_text: string | null;
  notes: string | null;
  status: string;
};

export function isRetailerDomain(value: unknown): value is RetailerDomain {
  return typeof value === "string" && Object.hasOwn(RETAILERS, value);
}

export function retailerDisplayName(domain: RetailerDomain): string {
  return RETAILERS[domain];
}

export function filterShoppingItems(items: ShoppingItem[]): ShoppingItem[] {
  // Optional lines are not included without a future explicit include flag.
  // A confirmed check_pantry line is represented by changing its status to required.
  return items.filter((item) => item.status === "required");
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.replace(/[\r\n]+/g, " ").trim() : "";
}

export function buildShoppingLine(item: ShoppingItem): string {
  const name = clean(item.item_name);
  const quantity = typeof item.quantity === "number" && Number.isFinite(item.quantity)
    ? String(item.quantity)
    : "";
  const quantityText = clean(item.quantity_text);
  const amount = [quantity, clean(item.unit)].filter(Boolean).join(" ") || quantityText;
  const note = clean(item.notes);
  return `${amount ? amount + " " : ""}${name}${note ? " — " + note : ""}`.trim();
}

export function buildPepestoInput(items: ShoppingItem[]): string {
  return filterShoppingItems(items).map(buildShoppingLine).filter(Boolean).join("\n");
}

const REDIRECT_HOSTS = new Set([
  "buy.pepesto.com",
  "app.pepesto.com",
  "s.pepesto.com",
  ...Object.keys(RETAILERS),
  "www.tesco.ie",
  "www.dunnesstoresgrocery.com",
]);

export function validateRedirectUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 4096) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && REDIRECT_HOSTS.has(url.hostname.toLowerCase())
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function packSize(quantity: Record<string, unknown> | null | undefined): string | null {
  if (!quantity) return null;
  const units: Array<[string, string]> = [
    ["grams", "g"], ["milliliters", "ml"], ["pieces", "pieces"], ["bunches", "bunches"],
  ];
  for (const [key, label] of units) {
    const value = quantity[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return `${value} ${label}`;
  }
  return null;
}

export function normalisePepestoResponse(
  raw: Record<string, unknown>,
  domain: RetailerDomain,
  requestedAt = new Date().toISOString(),
) {
  const rawItems = Array.isArray(raw.items) ? raw.items : [];
  const matchedItems: Record<string, unknown>[] = [];
  const unmatched = new Set(
    (Array.isArray(raw.not_indexed_items) ? raw.not_indexed_items : [])
      .filter((x): x is string => typeof x === "string"),
  );
  let subtotalCents = 0;
  let everySelectedProductHasPrice = true;

  for (const entry of rawItems) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as Record<string, unknown>;
    const requestedItem = typeof item.item_name === "string" ? item.item_name : "Requested item";
    const choices = Array.isArray(item.products) ? item.products : [];
    const choice = choices[0];
    if (!choice || typeof choice !== "object") {
      unmatched.add(requestedItem);
      continue;
    }
    const offer = choice as Record<string, unknown>;
    const product = offer.product && typeof offer.product === "object"
      ? offer.product as Record<string, unknown>
      : {};
    const price = product.price && typeof product.price === "object"
      ? product.price as Record<string, unknown>
      : {};
    const unitPriceCents = typeof price.price === "number" && Number.isFinite(price.price) ? price.price : null;
    const packs = typeof offer.num_units_to_buy === "number" && offer.num_units_to_buy > 0
      ? Math.ceil(offer.num_units_to_buy)
      : 0;
    const lineTotalCents = unitPriceCents !== null && packs > 0 ? unitPriceCents * packs : null;
    if (lineTotalCents === null) everySelectedProductHasPrice = false;
    else subtotalCents += lineTotalCents;

    matchedItems.push({
      requestedItem,
      productName: typeof product.product_name === "string" ? product.product_name : null,
      productImage: typeof product.pepesto_hosted_image_url === "string"
        ? product.pepesto_hosted_image_url
        : (typeof product.image_url === "string" ? product.image_url : null),
      productUrl: validateRedirectUrl(product.product_id),
      packSize: packSize(product.quantity as Record<string, unknown> | undefined),
      packs,
      unitPrice: unitPriceCents === null ? null : unitPriceCents / 100,
      lineTotal: lineTotalCents === null ? null : lineTotalCents / 100,
      isSubstitution: Boolean((product.classification as Record<string, unknown> | undefined)?.is_substitution),
      warnings: [],
      matchConfidence: null,
    });
  }

  const unmatchedItems = [...unmatched].map((requestedItem) => ({ requestedItem }));
  const warnings: string[] = [];
  if (unmatchedItems.length) warnings.push("Some requested items were not found in Pepesto's daily product cache.");
  if (!everySelectedProductHasPrice && matchedItems.length) warnings.push("Some matched products did not include a current price.");

  return {
    retailer: { name: retailerDisplayName(domain), domain },
    matchedItems,
    unmatchedItems,
    matchedCount: matchedItems.length,
    unmatchedCount: unmatchedItems.length,
    subtotal: matchedItems.length && everySelectedProductHasPrice ? subtotalCents / 100 : null,
    pricedSubtotal: matchedItems.length && subtotalCents > 0 ? subtotalCents / 100 : null,
    estimatedTotal: matchedItems.length && everySelectedProductHasPrice ? subtotalCents / 100 : null,
    currency: typeof raw.currency === "string" ? raw.currency : "EUR",
    completeBasket: matchedItems.length > 0 && unmatchedItems.length === 0,
    redirectUrl: validateRedirectUrl(raw.adjustments_url),
    warnings,
    requestedAt,
  };
}
