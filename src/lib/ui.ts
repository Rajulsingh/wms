const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/**
 * Escapes free text (order notes, anything else an admin typed) before it's
 * dropped into an `innerHTML` template — every picker/packer/admin screen in
 * this app renders that way rather than building DOM nodes by hand, so any
 * unescaped user-entered string is a real stored-XSS hole, not a
 * theoretical one. Use this anywhere a note/name/etc. lands inside a
 * template string, whether as element content or inside a quoted attribute.
 */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

/**
 * For actions that can't be predicted optimistically (their result depends
 * on a real network/DB call — importing orders, creating a batch, applying
 * an AWB) but still shouldn't leave a button looking inert after a tap.
 * Disables the button and swaps its label immediately, before the async
 * work starts, so the tap registers right away even though the actual
 * result still waits on the round trip. Restores the original label/state
 * in `finally` — harmless if the button's element gets replaced by a
 * re-render before this runs.
 */
export async function withLoading<T>(btn: HTMLButtonElement, loadingText: string, fn: () => Promise<T>): Promise<T> {
  const originalText = btn.textContent;
  const wasDisabled = btn.disabled;
  btn.disabled = true;
  btn.textContent = loadingText;
  try {
    return await fn();
  } finally {
    btn.disabled = wasDisabled;
    btn.textContent = originalText;
  }
}

/**
 * Modal confirmation gate for an action that's genuinely hard to undo (a
 * real Amazon shipping label purchase, a real pickup commitment) — mirrors
 * Amazon's own Seller Flex "Bulk Pack Confirmation" step (title, warning
 * text, a checkbox that has to be ticked before Continue enables) rather
 * than just trusting a button click. `title`/`message`/`continueLabel` are
 * caller-controlled static strings, not user input, so they're trusted
 * as-is — this isn't a place to interpolate anything typed by an admin.
 */
export function confirmDangerousAction(opts: { title: string; message: string; continueLabel?: string }): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.5); display:flex; align-items:center; justify-content:center; z-index:100; padding:20px;';
    overlay.innerHTML = `
      <div class="card stack" style="max-width: 420px; width: 100%;">
        <h2 style="margin:0;">${opts.title}</h2>
        <p>${opts.message}</p>
        <label class="row" style="align-items: center; gap: 8px; font-weight: 600;">
          <input type="checkbox" id="confirm-check" style="width: 20px; height: 20px;" />
          Are you sure you want to proceed?
        </label>
        <div class="row" style="gap: 10px;">
          <button class="btn btn-ghost" id="confirm-cancel" style="flex: 1;">Cancel</button>
          <button class="btn btn-primary" id="confirm-continue" style="flex: 1;" disabled>${opts.continueLabel ?? 'Continue'}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const checkbox = overlay.querySelector('#confirm-check') as HTMLInputElement;
    const continueBtn = overlay.querySelector('#confirm-continue') as HTMLButtonElement;
    checkbox.addEventListener('change', () => {
      continueBtn.disabled = !checkbox.checked;
    });
    overlay.querySelector('#confirm-cancel')?.addEventListener('click', () => {
      overlay.remove();
      resolve(false);
    });
    continueBtn.addEventListener('click', () => {
      overlay.remove();
      resolve(true);
    });
  });
}
