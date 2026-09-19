import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

/**
 * Stamps the package identifier in small text in the label's bottom-right
 * corner, matching how the warehouse already marks labels by hand and
 * matching Amazon's own "Package Identifier" field on the manual EasyShip
 * scheduling form (session 2 — this replaced an earlier SKU+qty stamp per
 * the user's explicit call). Only PDF labels are supported — the Workers
 * runtime has no canvas/raster compositing available for a PNG label; a
 * non-PDF label is returned unmodified rather than blocked, since this is a
 * finishing touch, not a correctness requirement for shipping.
 * Untested against a real Amazon label — Easy Ship label retrieval is still
 * blocked on SP-API role access (see HANDOFF.md open item 1) — verify the
 * corner placement once that unblocks, including which page of the combined
 * invoice+label+warranty PDF is actually the label (currently assumes last).
 */
export async function stampPackageIdentifier(labelBase64: string, labelFileType: string, packageIdentifier: string): Promise<{ base64: string; fileType: string }> {
  if (!/pdf/i.test(labelFileType) || !packageIdentifier.trim()) {
    return { base64: labelBase64, fileType: labelFileType };
  }

  try {
    const bytes = Uint8Array.from(atob(labelBase64), (c) => c.charCodeAt(0));
    const pdfDoc = await PDFDocument.load(bytes);
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const pages = pdfDoc.getPages();
    const page = pages[pages.length - 1];
    const { width } = page.getSize();

    const fontSize = 7;
    const margin = 6;
    const text = packageIdentifier.trim();
    const textWidth = font.widthOfTextAtSize(text, fontSize);
    page.drawText(text, {
      x: width - margin - textWidth,
      y: margin,
      size: fontSize,
      font,
      color: rgb(0, 0, 0)
    });

    const stamped = await pdfDoc.save();
    let binary = '';
    for (let i = 0; i < stamped.length; i++) binary += String.fromCharCode(stamped[i]);
    return { base64: btoa(binary), fileType: labelFileType };
  } catch {
    // A stamping failure should never block a label the seller already paid for.
    return { base64: labelBase64, fileType: labelFileType };
  }
}
