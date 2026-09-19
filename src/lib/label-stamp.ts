import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

/**
 * Draws one or more short lines, bottom-up, in the last page's bottom-right
 * corner — shared by stampPackageIdentifier (single line, SP-API path) and
 * the manual schedule-pickup flow's per-order label splitting (package
 * identifier + SKU short-code line, see label-pdf.ts), so both stamp the
 * same way instead of drifting apart. Untested against a real Amazon label —
 * verify the corner placement once a real one is available, including
 * whether the last page really is the label vs. an invoice/warranty page
 * (currently assumed, per HANDOFF.md open item 1).
 */
export async function stampCornerLines(pdfDoc: PDFDocument, lines: string[]): Promise<void> {
  const nonEmpty = lines.map((l) => l.trim()).filter(Boolean);
  if (!nonEmpty.length) return;

  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const pages = pdfDoc.getPages();
  const page = pages[pages.length - 1];
  const { width } = page.getSize();

  const fontSize = 7;
  const margin = 6;
  const lineHeight = fontSize + 2;
  [...nonEmpty].reverse().forEach((text, i) => {
    const textWidth = font.widthOfTextAtSize(text, fontSize);
    page.drawText(text, {
      x: width - margin - textWidth,
      y: margin + i * lineHeight,
      size: fontSize,
      font,
      color: rgb(0, 0, 0)
    });
  });
}

/**
 * Stamps the package identifier in small text in the label's bottom-right
 * corner, matching how the warehouse already marks labels by hand and
 * matching Amazon's own "Package Identifier" field on the manual EasyShip
 * scheduling form (session 2 — this replaced an earlier SKU+qty stamp per
 * the user's explicit call). Only PDF labels are supported — the Workers
 * runtime has no canvas/raster compositing available for a PNG label; a
 * non-PDF label is returned unmodified rather than blocked, since this is a
 * finishing touch, not a correctness requirement for shipping.
 */
export async function stampPackageIdentifier(labelBase64: string, labelFileType: string, packageIdentifier: string): Promise<{ base64: string; fileType: string }> {
  if (!/pdf/i.test(labelFileType) || !packageIdentifier.trim()) {
    return { base64: labelBase64, fileType: labelFileType };
  }

  try {
    const bytes = Uint8Array.from(atob(labelBase64), (c) => c.charCodeAt(0));
    const pdfDoc = await PDFDocument.load(bytes);
    await stampCornerLines(pdfDoc, [packageIdentifier]);

    const stamped = await pdfDoc.save();
    let binary = '';
    for (let i = 0; i < stamped.length; i++) binary += String.fromCharCode(stamped[i]);
    return { base64: btoa(binary), fileType: labelFileType };
  } catch {
    // A stamping failure should never block a label the seller already paid for.
    return { base64: labelBase64, fileType: labelFileType };
  }
}
