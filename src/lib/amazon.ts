import { env as workerEnv } from 'cloudflare:workers';
import { mapWithConcurrency } from './concurrency';

/**
 * Amazon Selling Partner API client — order pull only (§9 of the doc / the
 * "how do we get orders without an admin manually updating them" question).
 * Auth is LWA-only (client id/secret + refresh token -> short-lived access
 * token); SP-API removed the separate AWS SigV4 signing requirement for
 * these endpoints. Verify against Amazon's current SP-API docs before
 * relying on this in production — their auth requirements do shift over
 * time and this was written from general knowledge, not a fetched spec.
 *
 * FBA vs FBM: only Merchant-Fulfilled orders belong in this WMS's pick/pack
 * flow. `fetchUnfulfilledOrders` filters to FulfillmentChannel = "MFN".
 *
 * SHIPPING API: the `getEligibleShippingServices`/`purchaseShipment`
 * functions below target the classic Merchant Fulfillment Network (MFN)
 * API. Session 2 confirmed the seller actually ships via **EasyShip**
 * (Amazon arranges pickup) — a different SP-API product with a different,
 * mostly-async flow (see the "Easy Ship" section further down, confirmed
 * against Amazon's published request/response schemas, not guessed). The
 * MFN functions are left in place — fully working, schema-verified — in
 * case a non-EasyShip courier path is ever added, but nothing in the UI
 * calls them anymore. Don't be confused into "fixing" MFN's 403 again; that
 * was never the real bug, EasyShip was just the wrong API to call.
 */

interface AmazonEnv {
  AMAZON_LWA_CLIENT_ID: string;
  AMAZON_LWA_CLIENT_SECRET: string;
  AMAZON_REFRESH_TOKEN: string;
  AMAZON_MARKETPLACE_ID: string;
  AMAZON_SPAPI_SANDBOX?: string;
  AMAZON_MERCHANT_ID?: string;
}

function getEnv(): AmazonEnv {
  const required: (keyof AmazonEnv)[] = [
    'AMAZON_LWA_CLIENT_ID',
    'AMAZON_LWA_CLIENT_SECRET',
    'AMAZON_REFRESH_TOKEN',
    'AMAZON_MARKETPLACE_ID'
  ];
  for (const key of required) {
    if (!(workerEnv as unknown as Record<string, string | undefined>)[key]) {
      throw new Error(`Missing ${key} — set it in .dev.vars locally or via "wrangler secret put" in production.`);
    }
  }
  return workerEnv as unknown as AmazonEnv;
}

// SP-API has three regional endpoints, and a request to the wrong one for
// your marketplace 403s with "Access to requested resource is denied" —
// indistinguishable from a real permissions problem unless you already know
// to check this. Mapping covers the marketplaces sellers most commonly hit;
// add more here if a request 403s again and the marketplace isn't listed.
const MARKETPLACE_REGION: Record<string, 'na' | 'eu' | 'fe'> = {
  ATVPDKIKX0DER: 'na', // US
  A2EUQ1WTGCTBG2: 'na', // Canada
  A1AM78C64UM0Y8: 'na', // Mexico
  A2Q3Y263D00KWC: 'na', // Brazil
  A1F83G8C2ARO7P: 'eu', // UK
  A1PA6795UKMFR9: 'eu', // Germany
  A13V1IB3VIYZZH: 'eu', // France
  APJ6JRA9NG5V4: 'eu', // Italy
  A1RKKUPIHCS9HS: 'eu', // Spain
  A1805IZSGTT6HS: 'eu', // Netherlands
  A21TJRUUN4KGV: 'eu', // India
  A2VIGQ35RCS4UG: 'eu', // UAE
  A17E79C6D8DWNP: 'eu', // Saudi Arabia
  A1VC38T7YXB528: 'fe', // Japan
  A39IBJ37TRP1C6: 'fe', // Australia
  A19VAU5U5O7RUS: 'fe' // Singapore
};

function baseUrl(env: AmazonEnv): string {
  const region = MARKETPLACE_REGION[env.AMAZON_MARKETPLACE_ID] ?? 'na';
  const host = `sellingpartnerapi-${region}.amazon.com`;
  return env.AMAZON_SPAPI_SANDBOX === 'true' ? `https://sandbox.${host}` : `https://${host}`;
}

async function getAccessToken(env: AmazonEnv): Promise<string> {
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: env.AMAZON_REFRESH_TOKEN,
      client_id: env.AMAZON_LWA_CLIENT_ID,
      client_secret: env.AMAZON_LWA_CLIENT_SECRET
    })
  });
  if (!res.ok) {
    throw new Error(`LWA token exchange failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}

export interface AmazonOrderItem {
  orderItemId: string; // Amazon's own line-item id — required by the Merchant Fulfillment API when purchasing a label
  sellerSku: string;
  asin: string;
  title: string;
  quantityOrdered: number;
}

export interface AmazonOrder {
  amazonOrderId: string;
  purchaseDate: string;
  orderStatus: string;
  fulfillmentChannel: 'MFN' | 'AFN';
  earliestShipDate?: string;
  buyerName?: string;
  shippingAddress?: string;
  items: AmazonOrderItem[];
}

/**
 * Pulls unshipped, merchant-fulfilled orders updated since `since`. Meant to
 * run on a schedule (Cloudflare Cron Trigger) rather than only on manual click.
 *
 * The sandbox environment doesn't run your query against fake data — it
 * matches the request against a small set of Amazon's own canned scenarios
 * and 400s ("Could not match input arguments") on anything else. The only
 * documented working sandbox call is `CreatedAfter=TEST_CASE_200` with
 * MarketplaceIds=ATVPDKIKX0DER — no FulfillmentChannels/OrderStatuses
 * filters, no real dates. Real filtering only works against production.
 */
export async function fetchUnfulfilledOrders(since: Date): Promise<AmazonOrder[]> {
  const env = getEnv();
  const accessToken = await getAccessToken(env);
  const isSandbox = env.AMAZON_SPAPI_SANDBOX === 'true';
  const url = new URL(`${baseUrl(env)}/orders/v0/orders`);
  url.searchParams.set('MarketplaceIds', env.AMAZON_MARKETPLACE_ID);

  if (isSandbox) {
    url.searchParams.set('CreatedAfter', 'TEST_CASE_200');
  } else {
    url.searchParams.set('LastUpdatedAfter', since.toISOString());
    url.searchParams.set('FulfillmentChannels', 'MFN');
    // Pending included alongside Unshipped/PartiallyShipped — an order can
    // sit as Pending overnight (payment/COD confirmation) and be released
    // for fulfillment by morning; excluding it meant it never entered our
    // system at all until its status happened to flip before the next sync,
    // which isn't guaranteed. Amazon is still the source of truth for
    // whether it's actually ready — reserveOrderForPicking (orders.ts)
    // handles a Pending order the same as any other; if Amazon later
    // cancels it, syncOrderStatuses (amazon-sync.ts) catches that.
    url.searchParams.set('OrderStatuses', 'Pending,Unshipped,PartiallyShipped');
  }

  const res = await fetch(url, { headers: { 'x-amz-access-token': accessToken } });
  if (!res.ok) {
    const detail = await res.text();
    const hint = isSandbox
      ? ' (sandbox only recognizes its own canned test orders — this is expected to return Amazon\'s fixed sample data, not your real orders)'
      : '';
    throw new Error(`SP-API GetOrders failed: ${res.status} ${detail}${hint}`);
  }
  const data = (await res.json()) as {
    payload: { Orders: Array<Record<string, unknown>> };
  };

  // Sandbox ignores the FulfillmentChannels filter entirely (see above), so
  // enforce merchant-fulfilled-only here regardless of what the server did.
  const mfnOrders = (data.payload?.Orders ?? []).filter((raw) => raw.FulfillmentChannel === 'MFN');

  // GetOrderItems is one call per order with no bulk equivalent — fetched
  // with bounded concurrency instead of one at a time, which used to mean a
  // sync with 30 new orders paid 30 sequential network round trips back to
  // back. 5 at a time is well under Amazon's documented GetOrderItems burst
  // allowance (30) while still being a real speedup; the worker-pool shape
  // of mapWithConcurrency means it naturally throttles rather than firing
  // everything at once. Each fetch keeps its own try/catch exactly as the
  // old sequential loop did — one order's failure (a transient rate-limit or
  // 500, common here) must not cost every other order already fetched in
  // this same call; it returns null and is filtered out below, to be
  // retried on the next sync since `since` always looks back over the sync
  // job's own configurable window.
  const withItems = await mapWithConcurrency(mfnOrders, 5, async (raw) => {
    const orderId = raw.AmazonOrderId as string;
    // Sandbox's getOrderItems only recognizes the literal path "TEST_CASE_200"
    // — the real order id it just handed us in the GetOrders response 400s.
    const itemsOrderId = isSandbox ? 'TEST_CASE_200' : orderId;
    try {
      const itemsRes = await fetch(`${baseUrl(env)}/orders/v0/orders/${itemsOrderId}/orderItems`, {
        headers: { 'x-amz-access-token': accessToken }
      });
      if (!itemsRes.ok) throw new Error(`${itemsRes.status} ${await itemsRes.text()}`);
      const itemsData = (await itemsRes.json()) as { payload?: { OrderItems?: Array<Record<string, unknown>> } };
      const order: AmazonOrder = {
        amazonOrderId: orderId,
        purchaseDate: raw.PurchaseDate as string,
        orderStatus: raw.OrderStatus as string,
        fulfillmentChannel: raw.FulfillmentChannel as 'MFN' | 'AFN',
        earliestShipDate: raw.EarliestShipDate as string | undefined,
        buyerName: (raw.BuyerInfo as Record<string, unknown> | undefined)?.BuyerName as string | undefined,
        shippingAddress: raw.ShippingAddress ? JSON.stringify(raw.ShippingAddress) : undefined,
        items: (itemsData.payload?.OrderItems ?? []).map((item) => ({
          orderItemId: item.OrderItemId as string,
          sellerSku: item.SellerSKU as string,
          asin: item.ASIN as string,
          title: item.Title as string,
          quantityOrdered: Number(item.QuantityOrdered ?? 0)
        }))
      };
      return order;
    } catch (err) {
      console.error(`SP-API GetOrderItems failed for ${orderId}, skipping this order for now:`, err);
      return null;
    }
  });

  return withItems.filter((o): o is AmazonOrder => o !== null);
}

/**
 * Checks Amazon's *current* OrderStatus for a specific set of orders we
 * already have locally — used by the sync job to catch orders that changed
 * status through Amazon's own side (shipped by another means, cancelled by
 * the buyer/Amazon) rather than through our own pick/pack/ship flow.
 * `fetchUnfulfilledOrders` above only ever pulls new Unshipped/
 * PartiallyShipped orders and never revisits ones it's already seen — this
 * is the other half of that, a targeted lookup instead of a broad pull.
 * `AmazonOrderIds` accepts at most 50 ids per call (documented SP-API
 * limit), so this chunks.
 */
export async function fetchOrderStatuses(amazonOrderIds: string[]): Promise<Map<string, string>> {
  const env = getEnv();
  const accessToken = await getAccessToken(env);
  const result = new Map<string, string>();

  for (let i = 0; i < amazonOrderIds.length; i += 50) {
    const chunk = amazonOrderIds.slice(i, i + 50);
    const url = new URL(`${baseUrl(env)}/orders/v0/orders`);
    url.searchParams.set('MarketplaceIds', env.AMAZON_MARKETPLACE_ID);
    url.searchParams.set('AmazonOrderIds', chunk.join(','));

    const res = await fetch(url, { headers: { 'x-amz-access-token': accessToken } });
    if (!res.ok) throw new Error(`SP-API GetOrders (status check) failed: ${res.status} ${await res.text()}`);
    const data = (await res.json()) as { payload?: { Orders?: Array<{ AmazonOrderId: string; OrderStatus: string }> } };
    for (const o of data.payload?.Orders ?? []) {
      result.set(o.AmazonOrderId, o.OrderStatus);
    }
  }
  return result;
}

export interface CatalogItemDetails {
  title: string | null;
  imageUrl: string | null;
}

/**
 * Pulls the real product title and main image for an ASIN from the SP-API
 * Catalog Items endpoint (2022-04-01) — this is what lets the picker/packer
 * screens show an actual product photo instead of a placeholder, and what
 * fills in a SKU record automatically the first time an Amazon order
 * references it (§ "images and details can be fetched from real product
 * listings on amazon").
 */
export async function fetchCatalogItemDetails(asin: string): Promise<CatalogItemDetails> {
  const env = getEnv();
  const accessToken = await getAccessToken(env);
  const url = new URL(`${baseUrl(env)}/catalog/2022-04-01/items/${asin}`);
  url.searchParams.set('marketplaceIds', env.AMAZON_MARKETPLACE_ID);
  url.searchParams.set('includedData', 'images,summaries');

  const res = await fetch(url, { headers: { 'x-amz-access-token': accessToken } });
  if (!res.ok) {
    // Don't fail the whole import over one item's catalog lookup — the order still matters without a photo.
    return { title: null, imageUrl: null };
  }
  const data = (await res.json()) as {
    summaries?: Array<{ itemName?: string; marketplaceId?: string }>;
    images?: Array<{ marketplaceId?: string; images?: Array<{ variant?: string; link?: string }> }>;
  };

  const summary = data.summaries?.find((s) => s.marketplaceId === env.AMAZON_MARKETPLACE_ID) ?? data.summaries?.[0];
  const imageSet = data.images?.find((i) => i.marketplaceId === env.AMAZON_MARKETPLACE_ID) ?? data.images?.[0];
  const mainImage = imageSet?.images?.find((i) => i.variant === 'MAIN') ?? imageSet?.images?.[0];

  return { title: summary?.itemName ?? null, imageUrl: mainImage?.link ?? null };
}

export interface ListingSummary {
  sku: string;
  asin: string | null;
  title: string | null;
  imageUrl: string | null;
  // False for a variation-family "parent" listing — Amazon never marks one
  // BUYABLE since it can't actually be ordered (only its children can), and
  // confirmed against this seller's real catalog as the reliable signal for
  // it (see migrations/0019_skus_is_parent.sql). Defaults true when the
  // summary is missing a status array at all, to fail open rather than
  // accidentally treating a real product as unsellable on incomplete data.
  buyable: boolean;
}

/**
 * Pulls every active listing for this seller from the Listings Items API
 * (2021-08-01, `GET /listings/2021-08-01/items/{sellerId}`), confirmed
 * against Amazon's published request/response schema
 * (selling-partner-api-models/models/listings-items-api-model). Used to
 * sync the full Amazon catalog into local SKUs so Receiving's product
 * search covers everything the seller sells, not just SKUs that happened
 * to arrive via an order (see catalog-sync.ts). Unlike Catalog Items'
 * `keywords` search — which searches the *entire* Amazon catalog, not this
 * seller's own inventory, and has no fuzzy-name mode — this endpoint is
 * genuinely scoped to the seller (`sellerId`/`AMAZON_MERCHANT_ID` is a path
 * parameter here, not an optional filter), which is what makes it the
 * right tool for this. Capped at 1000 items / 50 pages of 20, matching
 * Amazon's own stated ceiling for this endpoint's pagination.
 */
export async function fetchAllListings(onPage?: (pageItems: ListingSummary[]) => void | Promise<void>): Promise<ListingSummary[]> {
  const env = getEnv();
  const sellerId = env.AMAZON_MERCHANT_ID;
  if (!sellerId) {
    throw new Error('AMAZON_MERCHANT_ID is not set — required as the sellerId path parameter for the Listings Items API.');
  }
  const accessToken = await getAccessToken(env);

  const results: ListingSummary[] = [];
  let pageToken: string | undefined;
  let pages = 0;
  do {
    const url = new URL(`${baseUrl(env)}/listings/2021-08-01/items/${sellerId}`);
    url.searchParams.set('marketplaceIds', env.AMAZON_MARKETPLACE_ID);
    url.searchParams.set('includedData', 'summaries');
    url.searchParams.set('pageSize', '20');
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const res = await fetch(url, { headers: { 'x-amz-access-token': accessToken } });
    if (!res.ok) {
      // A 403 here most likely means the SP-API app doesn't have the Listings
      // Items role granted in Seller Central yet — the same situation Easy
      // Ship was in before its role was granted (see HANDOFF.md). Surface the
      // real status/body rather than a generic failure so that's diagnosable.
      throw new Error(`Amazon Listings Items fetch failed: ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as {
      items?: Array<{
        sku: string;
        summaries?: Array<{ marketplaceId?: string; asin?: string; itemName?: string; mainImage?: { link?: string }; status?: string[] }>;
      }>;
      pagination?: { nextToken?: string };
    };

    const pageItems: ListingSummary[] = [];
    for (const item of data.items ?? []) {
      // mainImage lives nested inside each per-marketplace summary entry, not
      // as a top-level field on the item — confirmed against a real response
      // (the published JSON schema doesn't make this placement obvious).
      const summary = item.summaries?.find((s) => s.marketplaceId === env.AMAZON_MARKETPLACE_ID) ?? item.summaries?.[0];
      pageItems.push({
        sku: item.sku,
        asin: summary?.asin ?? null,
        title: summary?.itemName ?? null,
        imageUrl: summary?.mainImage?.link ?? null,
        buyable: summary?.status ? summary.status.includes('BUYABLE') : true
      });
    }
    results.push(...pageItems);
    // Reports each page as soon as it arrives instead of only after every
    // page has been fetched — lets a caller (catalog-sync's progress stream)
    // show real incremental progress for a sync that can take many pages
    // instead of one silent wait then a single jump to 100%.
    if (onPage) await onPage(pageItems);

    pageToken = data.pagination?.nextToken;
    pages++;
  } while (pageToken && pages < 50);

  return results;
}

/**
 * Merchant Fulfillment API (`/mfn/v0/...`) — buying an Amazon-negotiated
 * shipping label for a merchant-fulfilled order. Two calls: get rate
 * quotes for a box size/weight, then purchase one. Confirmed against
 * Amazon's own published request/response examples (selling-partner-api-
 * models/models/merchant-fulfillment-api-model/merchantFulfillmentV0.json)
 * rather than assumed, after getting a different endpoint's region wrong
 * earlier by guessing.
 */

export interface ShipFromAddress {
  name: string;
  addressLine1: string;
  city: string;
  stateOrProvinceCode: string;
  postalCode: string;
  countryCode: string;
  phone: string;
  email?: string;
}

export interface PackageDimensions {
  length: number;
  width: number;
  height: number;
  unit: 'centimeters' | 'inches';
}

export interface PackageWeight {
  value: number;
  unit: 'grams' | 'kilograms' | 'ounces' | 'pounds';
}

export interface MfnShipmentRequest {
  amazonOrderId: string;
  items: Array<{ orderItemId: string; quantity: number }>;
  shipFrom: ShipFromAddress;
  dimensions: PackageDimensions;
  weight: PackageWeight;
}

function buildShipmentRequestDetails(request: MfnShipmentRequest) {
  return {
    AmazonOrderId: request.amazonOrderId,
    ItemList: request.items.map((i) => ({ OrderItemId: i.orderItemId, Quantity: i.quantity })),
    ShipFromAddress: {
      Name: request.shipFrom.name,
      AddressLine1: request.shipFrom.addressLine1,
      City: request.shipFrom.city,
      StateOrProvinceCode: request.shipFrom.stateOrProvinceCode,
      PostalCode: request.shipFrom.postalCode,
      CountryCode: request.shipFrom.countryCode,
      Phone: request.shipFrom.phone,
      Email: request.shipFrom.email
    },
    PackageDimensions: {
      Length: request.dimensions.length,
      Width: request.dimensions.width,
      Height: request.dimensions.height,
      Unit: request.dimensions.unit
    },
    Weight: {
      Value: request.weight.value,
      Unit: request.weight.unit
    },
    ShippingServiceOptions: {
      DeliveryExperience: 'NoTracking',
      CarrierWillPickUp: false
    }
  };
}

export interface ShippingServiceOffer {
  shippingServiceId: string;
  shippingServiceOfferId: string;
  shippingServiceName: string;
  carrierName: string;
  rateAmount: number;
  rateCurrency: string;
  earliestEstimatedDeliveryDate?: string;
  latestEstimatedDeliveryDate?: string;
  requiresAdditionalSellerInputs: boolean;
}

/** Gets available carrier services + rates for a box size/weight against a specific order — call this first, let the admin pick one, then purchaseShipment with that offer id. */
export async function getEligibleShippingServices(request: MfnShipmentRequest): Promise<ShippingServiceOffer[]> {
  const env = getEnv();
  const accessToken = await getAccessToken(env);
  const res = await fetch(`${baseUrl(env)}/mfn/v0/eligibleShippingServices`, {
    method: 'POST',
    headers: { 'x-amz-access-token': accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ShipmentRequestDetails: buildShipmentRequestDetails(request) })
  });
  if (!res.ok) throw new Error(`MFN eligibleShippingServices failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { payload?: { ShippingServiceList?: Array<Record<string, any>> } };

  return (data.payload?.ShippingServiceList ?? []).map((s) => ({
    shippingServiceId: s.ShippingServiceId,
    shippingServiceOfferId: s.ShippingServiceOfferId,
    shippingServiceName: s.ShippingServiceName,
    carrierName: s.CarrierName,
    rateAmount: s.Rate?.Amount,
    rateCurrency: s.Rate?.CurrencyCode,
    earliestEstimatedDeliveryDate: s.EarliestEstimatedDeliveryDate,
    latestEstimatedDeliveryDate: s.LatestEstimatedDeliveryDate,
    requiresAdditionalSellerInputs: Boolean(s.RequiresAdditionalSellerInputs)
  }));
}

export interface PurchasedShipment {
  amazonShipmentId: string;
  trackingId: string;
  labelBase64: string;
  labelFileType: string;
}

/** Purchases the chosen offer — this spends real money on a real label. Returns the label already embedded as base64 in the response (no separate fetch/download call). */
export async function purchaseShipment(
  request: MfnShipmentRequest,
  shippingServiceId: string,
  shippingServiceOfferId: string
): Promise<PurchasedShipment> {
  const env = getEnv();
  const accessToken = await getAccessToken(env);
  const res = await fetch(`${baseUrl(env)}/mfn/v0/shipments`, {
    method: 'POST',
    headers: { 'x-amz-access-token': accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ShipmentRequestDetails: buildShipmentRequestDetails(request),
      ShippingServiceId: shippingServiceId,
      ShippingServiceOfferId: shippingServiceOfferId
    })
  });
  if (!res.ok) throw new Error(`MFN createShipment failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { payload?: Record<string, any> };
  const p = data.payload ?? {};

  return {
    amazonShipmentId: p.ShipmentId,
    trackingId: p.TrackingId,
    labelBase64: p.Label?.FileContents?.Contents,
    labelFileType: p.Label?.FileContents?.FileType
  };
}

// ============================================================================
// Easy Ship API — the seller's actual shipping program (confirmed session 2).
// Schemas confirmed against Amazon's published SP-API reference docs
// (developer-docs.amazon/sp-api/reference/listhandoverslots and
// /createscheduledpackage) — not guessed, same bar as the MFN code above.
// Untested against a live account: still blocked on the SP-API role/
// permission the seller needs for Easy Ship (same class of problem as the
// old MFN 403, different API). Verify the first real call closely once
// that's granted — in particular the Feeds/Reports pipeline below, which
// has no synchronous equivalent to sanity-check against.
// ============================================================================

export interface EasyShipDimensions {
  length: number;
  width: number;
  height: number;
  unit: 'cm';
}

export interface EasyShipWeight {
  value: number; // grams — Amazon requires >= 11
  unit: 'grams' | 'g';
}

export interface HandoverSlot {
  slotId: string;
  startTime: string;
  endTime: string;
  handoverMethod: 'PICKUP' | 'DROPOFF';
}

/**
 * Step 1 of scheduling — lists the handover time slots Amazon will offer for
 * this order's package (must be an Easy Ship order still in "unshipped"
 * state). Call this with the box/weight the package will actually ship in;
 * the chosen slot is then passed to `scheduleEasyShipPackage`.
 */
export async function listHandoverSlots(amazonOrderId: string, dimensions: EasyShipDimensions, weight: EasyShipWeight): Promise<HandoverSlot[]> {
  const env = getEnv();
  const accessToken = await getAccessToken(env);
  const res = await fetch(`${baseUrl(env)}/easyShip/2022-03-23/timeSlot`, {
    method: 'POST',
    headers: { 'x-amz-access-token': accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      marketplaceId: env.AMAZON_MARKETPLACE_ID,
      amazonOrderId,
      packageDimensions: dimensions,
      packageWeight: weight
    })
  });
  if (!res.ok) throw new Error(`EasyShip listHandoverSlots failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { timeSlots?: HandoverSlot[] };
  return data.timeSlots ?? [];
}

export interface ScheduledPackageResult {
  packageId: string;
  packageStatus: string;
  trackingId?: string;
  invoiceNumber?: string;
}

/**
 * Step 2 — books the chosen slot. Generates a label + invoice on Amazon's
 * side but does **not** return them here (unlike MFN's purchaseShipment) —
 * they're fetched separately via `requestEasyShipDocuments` +
 * `checkEasyShipFeed` + `checkEasyShipReport` below.
 */
export async function scheduleEasyShipPackage(
  amazonOrderId: string,
  slot: Pick<HandoverSlot, 'slotId' | 'startTime' | 'endTime' | 'handoverMethod'>,
  packageIdentifier?: string
): Promise<ScheduledPackageResult> {
  const env = getEnv();
  const accessToken = await getAccessToken(env);
  const res = await fetch(`${baseUrl(env)}/easyShip/2022-03-23/package`, {
    method: 'POST',
    headers: { 'x-amz-access-token': accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      amazonOrderId,
      marketplaceId: env.AMAZON_MARKETPLACE_ID,
      packageDetails: {
        packageTimeSlot: slot,
        ...(packageIdentifier ? { packageIdentifier } : {})
      }
    })
  });
  if (!res.ok) throw new Error(`EasyShip createScheduledPackage failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as {
    scheduledPackageId?: { packageId?: string };
    packageStatus?: string;
    trackingDetails?: { trackingId?: string };
    invoice?: { invoiceNumber?: string };
  };
  return {
    packageId: data.scheduledPackageId?.packageId ?? '',
    packageStatus: data.packageStatus ?? '',
    trackingId: data.trackingDetails?.trackingId,
    invoiceNumber: data.invoice?.invoiceNumber
  };
}

// ---- Feeds + Reports (generic SP-API) — used only to retrieve the Easy Ship
// label PDF. There is no synchronous "give me the label" call for Easy Ship;
// Amazon's own docs describe a three-step async pipeline: submit a feed
// requesting the documents, wait for it to process into a report reference,
// then fetch that report's document. Each function below is a single
// non-blocking check — callers should call these repeatedly from a poll loop
// driven by the UI (see src/lib/shipping.ts), not await/sleep inside one
// Worker request, since Amazon's processing time is unbounded from here.

async function spApiFetch(env: AmazonEnv, path: string, init?: RequestInit): Promise<Response> {
  const accessToken = await getAccessToken(env);
  return fetch(`${baseUrl(env)}${path}`, {
    ...init,
    headers: { ...(init?.headers ?? {}), 'x-amz-access-token': accessToken }
  });
}

/** Kicks off label/invoice retrieval — submits a POST_EASYSHIP_DOCUMENTS feed for this order. Returns the feed id to poll with `checkEasyShipFeed`. */
export async function requestEasyShipDocuments(amazonOrderId: string): Promise<{ feedId: string }> {
  const env = getEnv();

  // 1. Reserve a feed document slot — Amazon hands back a pre-signed upload URL.
  const docRes = await spApiFetch(env, '/feeds/2021-06-30/documents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contentType: 'text/xml; charset=UTF-8' })
  });
  if (!docRes.ok) throw new Error(`createFeedDocument failed: ${docRes.status} ${await docRes.text()}`);
  const doc = (await docRes.json()) as { feedDocumentId: string; url: string };

  // 2. Upload the feed XML (EasyshipDocuments.xsd) requesting the label + invoice.
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<AmazonEnvelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="amzn-envelope.xsd">
  <Header>
    <DocumentVersion>1.02</DocumentVersion>
    <MerchantIdentifier>${env.AMAZON_MARKETPLACE_ID}</MerchantIdentifier>
  </Header>
  <MessageType>EasyShipDocument</MessageType>
  <Message>
    <MessageID>1</MessageID>
    <EasyShipDocument>
      <AmazonOrderID>${amazonOrderId}</AmazonOrderID>
      <DocumentType>ShippingLabel</DocumentType>
      <DocumentType>Invoice</DocumentType>
    </EasyShipDocument>
  </Message>
</AmazonEnvelope>`;
  const uploadRes = await fetch(doc.url, { method: 'PUT', headers: { 'Content-Type': 'text/xml; charset=UTF-8' }, body: xml });
  if (!uploadRes.ok) throw new Error(`Feed document upload failed: ${uploadRes.status}`);

  // 3. Create the feed referencing the uploaded document.
  const feedRes = await spApiFetch(env, '/feeds/2021-06-30/feeds', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ feedType: 'POST_EASYSHIP_DOCUMENTS', marketplaceIds: [env.AMAZON_MARKETPLACE_ID], inputFeedDocumentId: doc.feedDocumentId })
  });
  if (!feedRes.ok) throw new Error(`createFeed failed: ${feedRes.status} ${await feedRes.text()}`);
  const feed = (await feedRes.json()) as { feedId: string };
  return { feedId: feed.feedId };
}

export interface FeedCheckResult {
  status: 'IN_QUEUE' | 'IN_PROGRESS' | 'DONE' | 'FATAL' | 'CANCELLED';
  reportReferenceId?: string;
}

/** One non-blocking check of feed processing. Once DONE, downloads the feed's own processing report to pull out the DocumentReportReferenceID — that id is what actually retrieves the label PDF next, via `checkEasyShipReport`. */
export async function checkEasyShipFeed(feedId: string): Promise<FeedCheckResult> {
  const env = getEnv();
  const res = await spApiFetch(env, `/feeds/2021-06-30/feeds/${feedId}`);
  if (!res.ok) throw new Error(`getFeed failed: ${res.status} ${await res.text()}`);
  const feed = (await res.json()) as { processingStatus: string; resultFeedDocumentId?: string };

  if (feed.processingStatus !== 'DONE' || !feed.resultFeedDocumentId) {
    return { status: feed.processingStatus as FeedCheckResult['status'] };
  }

  const docRes = await spApiFetch(env, `/feeds/2021-06-30/documents/${feed.resultFeedDocumentId}`);
  if (!docRes.ok) throw new Error(`getFeedDocument failed: ${docRes.status} ${await docRes.text()}`);
  const doc = (await docRes.json()) as { url: string };
  const reportRes = await fetch(doc.url);
  if (!reportRes.ok) throw new Error(`Feed result document download failed: ${reportRes.status}`);
  const reportText = await reportRes.text();

  const match = reportText.match(/<DocumentReportReferenceID>([^<]+)<\/DocumentReportReferenceID>/);
  if (!match) throw new Error('Feed processing report did not include a DocumentReportReferenceID — check the feed manually in Seller Central.');
  return { status: 'DONE', reportReferenceId: match[1] };
}

export interface ReportCheckResult {
  status: 'IN_QUEUE' | 'IN_PROGRESS' | 'DONE' | 'CANCELLED' | 'FATAL';
  labelBase64?: string;
  labelFileType?: string;
}

/** One non-blocking check of the report (the actual label+invoice PDF) status. */
export async function checkEasyShipReport(reportId: string): Promise<ReportCheckResult> {
  const env = getEnv();
  const res = await spApiFetch(env, `/reports/2021-06-30/reports/${reportId}`);
  if (!res.ok) throw new Error(`getReport failed: ${res.status} ${await res.text()}`);
  const report = (await res.json()) as { processingStatus: string; reportDocumentId?: string };

  if (report.processingStatus !== 'DONE' || !report.reportDocumentId) {
    return { status: report.processingStatus as ReportCheckResult['status'] };
  }

  const docRes = await spApiFetch(env, `/reports/2021-06-30/documents/${report.reportDocumentId}`);
  if (!docRes.ok) throw new Error(`getReportDocument failed: ${docRes.status} ${await docRes.text()}`);
  const doc = (await docRes.json()) as { url: string; compressionAlgorithm?: string };
  const pdfRes = await fetch(doc.url);
  if (!pdfRes.ok) throw new Error(`Report document download failed: ${pdfRes.status}`);

  let bytes: Uint8Array;
  if (doc.compressionAlgorithm === 'GZIP' && pdfRes.body) {
    const decompressed = pdfRes.body.pipeThrough(new DecompressionStream('gzip'));
    bytes = new Uint8Array(await new Response(decompressed).arrayBuffer());
  } else {
    bytes = new Uint8Array(await pdfRes.arrayBuffer());
  }

  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return { status: 'DONE', labelBase64: btoa(binary), labelFileType: 'application/pdf' };
}

// ---- Bulk scheduling — the better fit for "schedule several orders at
// once". Confirmed against the SDK's generated Go types (a more reliable
// source than prose docs for exact field names — developer-docs' HTML
// reference and the published Go/TS SDKs describe the same wire schema).
// Unlike single-order createScheduledPackage, the bulk response includes
// `printableDocumentsUrl` — a pre-signed URL to a ZIP of every scheduled
// order's label + compliance docs, generated synchronously. No separate
// Feeds/Reports polling pipeline needed for this path.

export interface BulkOrderSchedule {
  amazonOrderId: string;
  packageIdentifier?: string;
  packageTimeSlot?: Pick<HandoverSlot, 'slotId' | 'startTime' | 'endTime' | 'handoverMethod'>;
}

export interface BulkScheduledPackage {
  amazonOrderId: string;
  packageId: string;
  trackingId?: string;
  invoiceNumber?: string;
}

export interface BulkRejectedOrder {
  amazonOrderId: string;
  code: string;
  message: string;
}

export interface BulkScheduleResult {
  scheduled: BulkScheduledPackage[];
  rejected: BulkRejectedOrder[];
  printableDocumentsUrl?: string;
}

/** Schedules multiple orders in one call. A `packageTimeSlot` is optional per order — omit it and Amazon assigns the earliest available slot instead of requiring a `listHandoverSlots` call for every order first. */
export async function createScheduledPackageBulk(orders: BulkOrderSchedule[]): Promise<BulkScheduleResult> {
  const env = getEnv();
  const accessToken = await getAccessToken(env);
  const res = await fetch(`${baseUrl(env)}/easyShip/2022-03-23/packages/bulk`, {
    method: 'POST',
    headers: { 'x-amz-access-token': accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      marketplaceId: env.AMAZON_MARKETPLACE_ID,
      labelFormat: 'PDF',
      orderScheduleDetailsList: orders.map((o) => ({
        amazonOrderId: o.amazonOrderId,
        packageDetails: {
          ...(o.packageTimeSlot ? { packageTimeSlot: o.packageTimeSlot } : {}),
          ...(o.packageIdentifier ? { packageIdentifier: o.packageIdentifier } : {})
        }
      }))
    })
  });
  if (!res.ok) throw new Error(`EasyShip createScheduledPackageBulk failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as {
    scheduledPackages?: Array<{
      scheduledPackageId?: { amazonOrderId?: string; packageId?: string };
      trackingDetails?: { trackingId?: string };
      invoice?: { invoiceNumber?: string };
    }>;
    rejectedOrders?: Array<{ amazonOrderId: string; error?: { code?: string; message?: string } }>;
    printableDocumentsUrl?: string;
  };

  return {
    scheduled: (data.scheduledPackages ?? []).map((p) => ({
      amazonOrderId: p.scheduledPackageId?.amazonOrderId ?? '',
      packageId: p.scheduledPackageId?.packageId ?? '',
      trackingId: p.trackingDetails?.trackingId,
      invoiceNumber: p.invoice?.invoiceNumber
    })),
    rejected: (data.rejectedOrders ?? []).map((r) => ({
      amazonOrderId: r.amazonOrderId,
      code: r.error?.code ?? '',
      message: r.error?.message ?? ''
    })),
    printableDocumentsUrl: data.printableDocumentsUrl
  };
}
