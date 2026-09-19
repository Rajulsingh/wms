// Browser-only. ZXing decodes from the camera in pure JS, so this works on
// Safari/iOS too — the native BarcodeDetector API doesn't exist there, and
// the mixed Android/iPhone fleet decision (§ "Decisions locked") means we
// can't rely on it. This is the one scanning mechanism used everywhere:
// location QR labels, item barcodes, and AWB codes alike.
import { BrowserMultiFormatReader } from '@zxing/browser';
import type { IScannerControls } from '@zxing/browser';
import { BarcodeFormat, DecodeHintType } from '@zxing/library';

let activeControls: IScannerControls | null = null;

// Scoped to what this app actually scans — QR labels (stations, locations)
// and the common 1D symbologies carriers/retailers use for AWB and item
// barcodes. The unscoped default tries every format ZXing knows on every
// single frame, including several 2D formats (PDF417, Data Matrix, Aztec,
// MaxiCode, RSS) this app never produces or reads — a real, measurable
// slowdown per decode attempt for zero benefit. Narrowing this is the
// single biggest speed win available here.
const hints = new Map<DecodeHintType, unknown>([
  [
    DecodeHintType.POSSIBLE_FORMATS,
    [
      BarcodeFormat.QR_CODE,
      BarcodeFormat.CODE_128,
      BarcodeFormat.CODE_39,
      BarcodeFormat.EAN_13,
      BarcodeFormat.EAN_8,
      BarcodeFormat.UPC_A,
      BarcodeFormat.UPC_E,
      BarcodeFormat.ITF
    ]
  ]
]);

export function stopScanning(): void {
  activeControls?.stop();
  activeControls = null;
}

/** Resolves with the first decoded text from the camera, then stops the stream. Rejects if the camera can't be opened (permission denied, no camera, etc.) so the caller can fall back to manual entry. */
export async function scanOnce(videoEl: HTMLVideoElement): Promise<string> {
  stopScanning();
  // ZXing's own default retries a decode every 500ms when nothing's in
  // frame yet — most of the "scanning feels slow" complaint is just that
  // gap, not the camera or the decoder itself. 75ms keeps it responsive
  // without pegging the CPU on a phone that's held for a few seconds at a
  // time, not continuously.
  const reader = new BrowserMultiFormatReader(hints, { delayBetweenScanAttempts: 75 });

  return new Promise<string>((resolve, reject) => {
    reader
      .decodeFromConstraints(
        {
          video: {
            facingMode: 'environment',
            // Higher than the browser's low-res default so a small/far
            // barcode actually resolves — still light enough to decode
            // fast at 75ms intervals. `advanced` focus constraints are
            // ignored harmlessly where unsupported (Safari/iOS) rather
            // than failing the whole request.
            width: { ideal: 1280 },
            height: { ideal: 720 },
            advanced: [{ focusMode: 'continuous' } as MediaTrackConstraintSet]
          }
        },
        videoEl,
        (result, _err, controls) => {
          activeControls = controls;
          if (result) {
            controls.stop();
            activeControls = null;
            resolve(result.getText());
          }
          // NotFoundException fires continuously while no code is in frame — not a real error, ignore it.
        }
      )
      .catch((err) => reject(err));
  });
}
