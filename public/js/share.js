/**
 * "Guardar" / "Enviar" for recorded takes.
 *
 * A web page can't write into the phone's gallery or Google Photos directly;
 * the two real mechanisms are:
 * - a download (Android puts it in Download/, which the gallery and Google
 *   Photos list as an on-device album), and
 * - the Web Share API with the File itself, which hands it to the OS share
 *   sheet: Google Photos ("Subir a Fotos"), WhatsApp, Telegram, Drive...,
 *   and on iPhone "Guardar video" (into Photos).
 *
 * Sharing passes *only* the file — no title/text. With text attached, some
 * targets (WhatsApp among them) treat the share as a message with an
 * attachment and may send the video as a document; a lone `video/mp4` file
 * opens their video composer and goes out as a playable video.
 */

const ua = navigator.userAgent || '';
const IS_IOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const IS_ANDROID = /Android/i.test(ua);

export function canShareFile(file) {
  try {
    return !!(file && navigator.canShare && navigator.canShare({ files: [file] }));
  } catch (_) {
    return false;
  }
}

export class ShareActions {
  /**
   * @param {HTMLElement} sheetRoot the #sheet element from index.html
   * @param {(message: string, ms?: number) => void} notify toast function
   */
  constructor(sheetRoot, notify) {
    this.sheet = sheetRoot;
    this.notify = notify;
    this.titleEl = sheetRoot.querySelector('[data-el="sheet-title"]');
    this.optionsEl = sheetRoot.querySelector('[data-el="sheet-options"]');
    this.returnFocusTo = null;

    sheetRoot.querySelectorAll('[data-sheet-close]').forEach((el) => {
      el.addEventListener('click', () => this.closeSheet());
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.isSheetOpen) {
        e.stopImmediatePropagation(); // don't also close the player underneath
        this.closeSheet();
      }
    }, true);
  }

  get isSheetOpen() {
    return !this.sheet.classList.contains('hidden');
  }

  /** Whether "Enviar" makes sense on this device/browser. */
  canSend(recording) {
    return canShareFile(recording.file);
  }

  save(recording) {
    if (!canShareFile(recording.file) || (!IS_ANDROID && !IS_IOS)) {
      // Desktop (or a browser without file sharing): a plain download is the
      // only meaningful "save".
      this.download(recording);
      return;
    }
    const options = IS_IOS
      ? [
        {
          title: 'Fotos',
          detail: 'Se abre el menú de compartir: elige «Guardar video».',
          run: () => this.share(recording),
        },
        {
          title: 'Archivos',
          detail: 'Se descarga en la app Archivos.',
          run: () => this.download(recording),
        },
      ]
      : [
        {
          title: 'Galería del teléfono',
          detail: 'Se descarga al teléfono y aparece en la galería (álbum «Download»).',
          run: () => this.download(recording),
        },
        {
          title: 'Google Fotos',
          detail: 'Se abre el menú de compartir: elige «Fotos» (Subir a Fotos).',
          run: () => this.share(recording),
        },
      ];
    this.openSheet('Guardar video', options);
  }

  send(recording) {
    if (!canShareFile(recording.file)) {
      this.notify('Este navegador no permite enviar videos. Descárgalo y envíalo desde la galería.', 5000);
      return;
    }
    this.share(recording);
  }

  download(recording) {
    const a = document.createElement('a');
    a.href = recording.url;
    a.download = recording.name;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    if (IS_ANDROID) this.notify('Descargando… lo encontrarás en la galería, álbum «Download».', 4000);
  }

  async share(recording) {
    try {
      await navigator.share({ files: [recording.file] });
    } catch (err) {
      if (err && err.name === 'AbortError') return; // user closed the sheet
      console.warn('[MotionMirror] share failed', err);
      this.notify('No se pudo abrir el menú para compartir el video.', 4000);
    }
  }

  openSheet(title, options) {
    this.returnFocusTo = document.activeElement;
    this.titleEl.textContent = title;
    this.optionsEl.innerHTML = '';
    options.forEach((opt) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'sheet-option';
      const t = document.createElement('span');
      t.className = 'sheet-option-title';
      t.textContent = opt.title;
      const d = document.createElement('span');
      d.className = 'sheet-option-detail';
      d.textContent = opt.detail;
      btn.append(t, d);
      // navigator.share() needs a fresh user gesture, so run the action
      // synchronously inside this click before closing the sheet.
      btn.addEventListener('click', () => {
        opt.run();
        this.closeSheet();
      });
      this.optionsEl.appendChild(btn);
    });
    this.sheet.classList.remove('hidden');
    const first = this.optionsEl.querySelector('button');
    if (first) first.focus({ preventScroll: true });
  }

  closeSheet() {
    if (!this.isSheetOpen) return;
    this.sheet.classList.add('hidden');
    if (this.returnFocusTo && this.returnFocusTo.isConnected) this.returnFocusTo.focus({ preventScroll: true });
  }
}
