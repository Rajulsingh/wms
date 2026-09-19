// Browser-only. ZXing decodes from the camera in pure JS, so this works on
// Safari/iOS too — the native BarcodeDetector API doesn't exist there, and
// the mixed Android/iPhone fleet decision (§ "Decisions locked") means we
// can't rely on it. This is the one scanning mechanism used everywhere:
// location QR labels, item barcodes, and AWB codes alike.
import { BrowserMultiFormatReader } from '@zxing/browser';
import type { IScannerControls } from '@zxing/browser';

let activeControls: IScannerControls | null = null;

export function stopScanning(): void {
  activeControls?.stop();
  activeControls = null;
}

/** Resolves with the first decoded text from the camera, then stops the stream. Rejects if the camera can't be opened (permission denied, no camera, etc.) so the caller can fall back to manual entry. */
export async function scanOnce(videoEl: HTMLVideoElement): Promise<string> {
  stopScanning();
  const reader = new BrowserMultiFormatReader();

  return new Promise<string>((resolve, reject) => {
    reader
      .decodeFromVideoDevice(undefined, videoEl, (result, _err, controls) => {
        activeControls = controls;
        if (result) {
          controls.stop();
          activeControls = null;
          resolve(result.getText());
        }
        // NotFoundException fires continuously while no code is in frame — not a real error, ignore it.
      })
      .catch((err) => reject(err));
  });
}
