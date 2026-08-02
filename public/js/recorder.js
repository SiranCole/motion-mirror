const MIME_CANDIDATES = [
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
  'video/mp4;codecs=h264',
  'video/mp4',
];

function pickMimeType() {
  for (const type of MIME_CANDIDATES) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(type)) return type;
  }
  return '';
}

/**
 * Records exactly whatever MediaStream it's given (WYSIWYG: the caller
 * decides whether that's the raw camera track or canvas.captureStream() from
 * the delayed view, matching whatever mode is on screen when recording
 * starts).
 */
export class RecordingController extends EventTarget {
  constructor() {
    super();
    this.mediaRecorder = null;
    this.chunks = [];
    this.startedAt = 0;
    this.mimeType = pickMimeType();
  }

  get isRecording() {
    return !!this.mediaRecorder && this.mediaRecorder.state === 'recording';
  }

  start(stream, meta = {}) {
    if (this.isRecording) return;
    if (!this.mimeType) {
      throw new Error('Este navegador no soporta MediaRecorder para video.');
    }
    this.chunks = [];
    this.mediaRecorder = new MediaRecorder(stream, { mimeType: this.mimeType });
    this.mediaRecorder.addEventListener('dataavailable', (e) => {
      if (e.data && e.data.size > 0) this.chunks.push(e.data);
    });
    this.mediaRecorder.addEventListener('stop', () => {
      const blob = new Blob(this.chunks, { type: this.mimeType });
      const url = URL.createObjectURL(blob);
      const durationMs = performance.now() - this.startedAt;
      this.dispatchEvent(new CustomEvent('recording', {
        detail: { blob, url, durationMs, mimeType: this.mimeType, meta },
      }));
      this.chunks = [];
    });
    this.startedAt = performance.now();
    this.mediaRecorder.start(1000); // 1s timeslices: bounds memory, keeps partial data safe on crash
  }

  stop() {
    if (this.isRecording) this.mediaRecorder.stop();
  }
}

export function fileExtensionFor(mimeType) {
  return mimeType.includes('mp4') ? 'mp4' : 'webm';
}
