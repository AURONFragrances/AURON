// Cloudflare Worker: serves the static site and handles POST /api/checkout.
// Prices, shipping and tax live HERE so they can't be tampered with from the browser.
// Secrets (set in Cloudflare, never in this file):
//   SQUARE_ACCESS_TOKEN, SQUARE_LOCATION_ID
// Optional secret for testing: SQUARE_API_BASE = https://connect.squareupsandbox.com

const FRAGRANCES = {
  'auron-01': 'N° 01 CREMA ÁMBAR',
  'auron-02': 'N° 02 AMATA',
  'auron-03': 'N° 03 PINK PEPPER',
  'auron-04': 'N° 04 SERENE GREEN',
  'auron-05': 'N° 05 OCTOBER 27',
  'auron-06': 'N° 06 OUT OF LUCK'
};
const SIZES = {
  '15ml': { label: '15 mL', cents: 1700 },
  '30ml': { label: '30 mL', cents: 3000 }
};
const SHIPPING_CENTS = 1000;   // flat $10 shipping (taxable)
const TAX_PERCENT = '6';       // sales tax
const PICKUP_NOTE = 'You will receive an email to discuss a time and location for local pick up.';

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/checkout') {
      if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
      return handleCheckout(request, env, url.origin);
    }
    return env.ASSETS.fetch(request);
  }
};

async function handleCheckout(request, env, origin) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: 'Bad request' }, 400); }

  const items = Array.isArray(body.items) ? body.items : [];
  const line_items = [];
  for (const it of items) {
    const name = FRAGRANCES[it.id];
    const size = SIZES[it.size];
    const qty = Number.parseInt(it.qty, 10);
    if (!name || !size || !(qty >= 1 && qty <= 10)) return json({ error: 'Invalid cart' }, 400);
    line_items.push({
      name: `${name} — Eau de Parfum, ${size.label}`,
      quantity: String(qty),
      base_price_money: { amount: size.cents, currency: 'USD' }
    });
  }
  if (!line_items.length) return json({ error: 'Cart is empty' }, 400);

  const pickup = body.delivery === 'pickup';
  const order = {
    location_id: env.SQUARE_LOCATION_ID,
    line_items,
    taxes: [{ name: 'Sales Tax', percentage: TAX_PERCENT, scope: 'ORDER', type: 'ADDITIVE' }]
  };
  if (pickup) {
    order.fulfillments = [{ type: 'PICKUP', pickup_details: { prep_time_duration: 'P3D', note: PICKUP_NOTE } }];
  } else {
    order.service_charges = [{
      name: 'Shipping',
      amount_money: { amount: SHIPPING_CENTS, currency: 'USD' },
      calculation_phase: 'SUBTOTAL_PHASE',
      taxable: true
    }];
  }

  const base = env.SQUARE_API_BASE || 'https://connect.squareup.com';
  try {
    const r = await fetch(`${base}/v2/online-checkout/payment-links`, {
      method: 'POST',
      headers: {
        'Square-Version': '2024-10-17',
        'Authorization': `Bearer ${env.SQUARE_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        idempotency_key: crypto.randomUUID(),
        order,
        checkout_options: {
          // Return to whichever address the customer is on (live site, preview, or local)
          redirect_url: `${origin}/?order=complete`,
          ask_for_shipping_address: !pickup
        }
      })
    });
    const data = await r.json();
    if (!r.ok || !data.payment_link) {
      console.error('Square error:', JSON.stringify(data));
      return json({ error: 'Could not create checkout' }, 502);
    }
    return json({ url: data.payment_link.url });
  } catch (err) {
    console.error(err);
    return json({ error: 'Server error' }, 500);
  }
}
