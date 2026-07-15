import {
  assertEquals,
  assertMatch,
} from "jsr:@std/assert@1";
import {
  buildPepestoInput,
  filterShoppingItems,
  isRetailerDomain,
  normalisePepestoResponse,
  validateRedirectUrl,
  type ShoppingItem,
} from "./helpers.ts";

const item = (overrides: Partial<ShoppingItem> = {}): ShoppingItem => ({
  item_name: "milk", quantity: 2, unit: "litres", quantity_text: null,
  notes: null, status: "required", ...overrides,
});

Deno.test("filters shopping list statuses conservatively", () => {
  const items = [item(), item({ status: "optional" }), item({ status: "check_pantry" }), item({ status: "bought" })];
  assertEquals(filterShoppingItems(items).length, 1);
});

Deno.test("builds normalised shopping text and preserves important notes", () => {
  assertEquals(buildPepestoInput([item({ notes: "coeliac-safe, no substitution" })]),
    "2 litres milk — coeliac-safe, no substitution");
  assertMatch(buildPepestoInput([item({ quantity: null, unit: null, quantity_text: "one large" })]), /^one large milk/);
});

Deno.test("allowlists retailer domains", () => {
  assertEquals(isRetailerDomain("tesco.ie"), true);
  assertEquals(isRetailerDomain("evil.example"), false);
});

Deno.test("validates redirect URLs", () => {
  assertEquals(validateRedirectUrl("https://buy.pepesto.com/cart/abc"), "https://buy.pepesto.com/cart/abc");
  assertEquals(validateRedirectUrl("https://buy.pepesto.com.evil.example/cart"), null);
  assertEquals(validateRedirectUrl("javascript:alert(1)"), null);
});

Deno.test("normalises genuine products response fields", () => {
  const result = normalisePepestoResponse({
    currency: "EUR",
    adjustments_url: "https://buy.pepesto.com/cart/abc",
    items: [{ item_name: "milk", products: [{
      num_units_to_buy: 2,
      product: { product_name: "Irish Milk", quantity: { milliliters: 1000 }, price: { price: 180 } },
    }] }],
    not_indexed_items: ["saffron"],
  }, "tesco.ie", "2026-07-15T00:00:00.000Z");
  assertEquals(result.matchedCount, 1);
  assertEquals(result.unmatchedCount, 1);
  assertEquals(result.estimatedTotal, 3.6);
  assertEquals(result.completeBasket, false);
  assertEquals(result.redirectUrl, "https://buy.pepesto.com/cart/abc");
});
