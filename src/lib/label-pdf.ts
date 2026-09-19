import { PDFDocument } from 'pdf-lib';
import { extractText, getDocumentProxy } from 'unpdf';
import { stampCornerLines } from './label-stamp';

/**
 * Per-page text of the label+invoice PDF Amazon hands back after a manual
 * Schedule Pickup upload. Confirmed to run under the real Workers runtime
 * (workerd), not just Node — see the spike this was verified with before
 * building on it. Real Amazon export not yet seen — if a page turns out to
 * be a scanned/rasterized image with no extractable text, it'll come back
 * empty and fall through to matchPagesToOrders' "inherits the previous
 * match" behavior or, if nothing precedes it, the unmatched list.
 *
 * Detaches `bytes`' underlying ArrayBuffer as a side effect (confirmed
 * directly, not documented by unpdf/pdf.js) — pass a copy (`bytes.slice()`)
 * if the caller needs the same buffer again afterward.
 */
export async function extractPageTexts(bytes: Uint8Array): Promise<string[]> {
  const pdf = await getDocumentProxy(bytes);
  const { text } = await extractText(pdf, { mergePages: false });
  return text;
}

export interface MatchCandidate {
  shipmentId: string;
  externalOrderId: string;
  invoiceId: string | null;
}

export interface MatchResult {
  matched: Map<string, number[]>; // shipmentId -> page indices, in order
  unmatched: number[];
}

/**
 * Assigns each page to whichever of *this batch's own* pending orders its
 * text contains the order id or invoice id for — deliberately not a generic
 * "does this look like an order id" regex, since we already know the exact
 * small set of ids to look for. A page with no id of its own (a trailing
 * invoice/compliance page that doesn't repeat the order id as text) inherits
 * whichever order's pages came immediately before it, which is how a
 * label+invoice pair stays grouped without assuming a fixed page count or
 * order per order — see the plan's "don't assume a fixed page pattern" call.
 */
export function matchPagesToOrders(pageTexts: string[], candidates: MatchCandidate[]): MatchResult {
  const matched = new Map<string, number[]>();
  const unmatched: number[] = [];
  let current: string | null = null;

  for (let i = 0; i < pageTexts.length; i++) {
    const text = pageTexts[i] ?? '';
    const hit = candidates.find((c) => (c.externalOrderId && text.includes(c.externalOrderId)) || (c.invoiceId && text.includes(c.invoiceId)));
    if (hit) {
      current = hit.shipmentId;
      const arr = matched.get(current) ?? [];
      arr.push(i);
      matched.set(current, arr);
    } else if (current) {
      matched.get(current)!.push(i);
    } else {
      unmatched.push(i);
    }
  }
  return { matched, unmatched };
}

/** Copies just the given pages out of the uploaded PDF into a fresh small document and stamps it — same corner-stamp convention as the SP-API path's stampPackageIdentifier. */
export async function buildStampedOrderPdf(sourceBytes: Uint8Array, pageIndices: number[], stampLines: string[]): Promise<Uint8Array> {
  const src = await PDFDocument.load(sourceBytes);
  const out = await PDFDocument.create();
  const copied = await out.copyPages(src, pageIndices);
  copied.forEach((p) => out.addPage(p));
  await stampCornerLines(out, stampLines);
  return out.save();
}
