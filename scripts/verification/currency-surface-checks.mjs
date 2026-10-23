import assert from "node:assert/strict";

export const veraMoney = (amountCents, currency) => new Intl.NumberFormat(
  currency === "INR" ? "en-IN" : "en-US",
  { style: "currency", currency, minimumFractionDigits: 0, maximumFractionDigits: 2 },
).format(amountCents / 100);

export const expectedVeraPrices = (currency) => currency === "INR"
  ? [10_000, 3_150_000, 3_490_000]
  : [200, 38_500, 42_000];

export const verifyVeraCurrencySurfaces = async ({ page, request, base, currency, label, output, browserErrors = [] }) => {
  const prices = expectedVeraPrices(currency);
  const deposit = currency === "INR" ? 650_000 : 8_000;
  const formatted = prices.map((amount) => veraMoney(amount, currency));
  const depositText = veraMoney(deposit, currency);
  const response = await request.get(new URL("/api/astropages/generated-site/vera/catalog", base).href);
  const payload = await response.json();
  assert.equal(response.status(), 200, `${label} catalog: ${JSON.stringify(payload)}`);
  assert.match(response.headers()["cache-control"] ?? "", /no-store/);
  assert.equal(payload.data.currency, currency);
  assert.equal(payload.data.depositCents, deposit);
  assert.deepEqual(payload.data.services.map(({ priceCents }) => priceCents), prices);

  const visit = async (path) => {
    const navigation = await page.goto(new URL(path, base).href, { waitUntil: "networkidle" });
    assert.equal(navigation?.status(), 200, `${label} ${path}`);
    return page.locator("body").innerText();
  };
  const home = await visit("/");
  assert.ok(home.includes(formatted[0]), `${label} home ${formatted[0]}`);
  const readings = await visit("/readings");
  assert.ok(readings.includes(formatted[0]), `${label} readings ${formatted[0]}`);
  const detail = await visit("/readings/natal-hour");
  assert.ok(detail.includes(formatted[0]), `${label} detail ${formatted[0]}`);
  assert.ok((await page.locator("body").textContent()).includes(depositText), `${label} detail deposit ${depositText}`);
  const booking = await visit("/booking?service=natal-hour");
  await page.waitForTimeout(1_000);
  const bookingText = await page.locator("body").innerText();
  assert.ok(bookingText.includes(formatted[0]), `${label} booking ${formatted[0]}; errors: ${browserErrors.join(" | ")}`);
  assert.equal(await page.locator("[data-payment-currency-selector]").count(), 0, `${label} visitor currency selector absent`);
  await page.setViewportSize({ width: 390, height: 844 });
  await visit("/readings/natal-hour");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `${label} mobile overflow`);
  await page.screenshot({ path: `${output}/${label}-mobile.png`, fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  return { currency, prices, deposit, home: true, readings: true, detail: true, booking: true, mobile: true };
};
