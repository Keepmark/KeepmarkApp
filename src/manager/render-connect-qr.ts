import QRCode from 'qrcode';
import { ConnectQrMaxBytes } from '../shared/connect-qr.js';
import { t } from '../shared/i18n.js';

/** Keep the entire white backing within ten percent of the code width. */
export function drawConnectQrLogo(canvas: HTMLCanvasElement, image: CanvasImageSource): void {
  const context = canvas.getContext('2d');
  if (!context) throw new Error('QR canvas unavailable');
  const side = Math.floor(Math.min(canvas.width, canvas.height) / 10);
  const padding = Math.max(1, Math.floor(side / 12));
  const x = Math.floor((canvas.width - side) / 2);
  const y = Math.floor((canvas.height - side) / 2);
  context.save();
  try {
    context.fillStyle = '#ffffff';
    context.fillRect(x, y, side, side);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(image, x + padding, y + padding, side - 2 * padding, side - 2 * padding);
  } finally {
    context.restore();
  }
}

function loadLogo(image: HTMLImageElement): Promise<void> {
  return new Promise((resolve, reject) => {
    const release = (): void => { image.onload = null; image.onerror = null; };
    image.onload = () => { release(); resolve(); };
    image.onerror = () => { release(); reject(new Error('QR logo unavailable')); };
    image.src = 'assets/icon128.png';
  });
}

/** Local branded QR rendering, with stronger correction when capacity permits. */
export async function renderConnectQr(canvas: HTMLCanvasElement, json: string): Promise<void> {
  const bytes = new TextEncoder().encode(json).byteLength;
  if (bytes > ConnectQrMaxBytes) throw new Error(t('qr.tooLarge'));
  const errorCorrectionLevel = bytes <= 1200 ? 'H' : bytes <= 1600 ? 'Q' : 'M';
  const moduleCount = QRCode.create(json, { errorCorrectionLevel }).modules.size;
  // Whole pixels per module avoid blurring dense symbols at arbitrary widths.
  const scale = Math.max(3, Math.ceil(360 / (moduleCount + 8)));
  await QRCode.toCanvas(canvas, json, {
    scale,
    margin: 4,
    errorCorrectionLevel,
    color: { dark: '#000000', light: '#ffffff' },
  });
  const image = new Image();
  try {
    await loadLogo(image);
    drawConnectQrLogo(canvas, image);
  } finally {
    image.onload = null;
    image.onerror = null;
    image.removeAttribute('src');
  }
}
