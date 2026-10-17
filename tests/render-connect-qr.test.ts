// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('qrcode', () => ({ default: { toCanvas: vi.fn(async () => undefined), create: vi.fn(() => ({ modules: { size: 129 } })) } }));
import QRCode from 'qrcode';
import { drawConnectQrLogo, renderConnectQr } from '../src/manager/render-connect-qr';

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

function mockImage(fail = false): HTMLImageElement[] {
  const images: HTMLImageElement[] = [];
  vi.stubGlobal('Image', class {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    set src(value: string) {
      expect(value).toBe('assets/icon128.png');
      queueMicrotask(() => { if (fail) this.onerror?.(); else this.onload?.(); });
    }
    removeAttribute = vi.fn();
    constructor() { images.push(this as unknown as HTMLImageElement); }
  });
  return images;
}
function canvas(): { canvas: HTMLCanvasElement; context: { save: ReturnType<typeof vi.fn>; restore: ReturnType<typeof vi.fn>; fillRect: ReturnType<typeof vi.fn>; drawImage: ReturnType<typeof vi.fn>; fillStyle: string } } {
  const context = { save: vi.fn(), restore: vi.fn(), fillRect: vi.fn(), drawImage: vi.fn(), fillStyle: '' };
  return { canvas: { width: 360, height: 360, getContext: () => context } as unknown as HTMLCanvasElement, context };
}
it('centers the logo in a white backing at most ten percent wide', () => {
  const target = canvas(); const image = document.createElement('img');
  drawConnectQrLogo(target.canvas, image);
  expect(target.context.fillRect).toHaveBeenCalledWith(162, 162, 36, 36);
  expect(target.context.drawImage).toHaveBeenCalledWith(image, 165, 165, 30, 30);
  expect(target.context.fillStyle).toBe('#ffffff');
  expect(target.context.restore).toHaveBeenCalledOnce();
});
it.each([[1200, 'H'], [1201, 'Q'], [1600, 'Q'], [1601, 'M'], [1800, 'M']] as const)('uses correction %s-byte boundary', async (bytes, level) => {
  const images = mockImage(); const target = canvas();
  await renderConnectQr(target.canvas, 'a'.repeat(bytes));
  expect(QRCode.toCanvas).toHaveBeenCalledWith(target.canvas, 'a'.repeat(bytes), expect.objectContaining({ scale: 3, margin: 4, errorCorrectionLevel: level }));
  expect(images[0].onload).toBeNull(); expect(images[0].onerror).toBeNull();
  expect(images[0].removeAttribute).toHaveBeenCalledWith('src');
});
it('counts UTF-8 bytes and rejects oversized payloads without truncation', async () => {
  mockImage(); const target = canvas();
  await renderConnectQr(target.canvas, 'é'.repeat(601));
  expect(QRCode.toCanvas).toHaveBeenLastCalledWith(target.canvas, 'é'.repeat(601), expect.objectContaining({ errorCorrectionLevel: 'Q' }));
  vi.mocked(QRCode.toCanvas).mockClear();
  await expect(renderConnectQr(target.canvas, 'é'.repeat(901))).rejects.toThrow();
  expect(QRCode.toCanvas).not.toHaveBeenCalled();
});
it('fails safely when the local logo cannot load and releases callbacks', async () => {
  const images = mockImage(true); const target = canvas();
  await expect(renderConnectQr(target.canvas, '{}')).rejects.toThrow('QR logo unavailable');
  expect(images[0].onload).toBeNull(); expect(images[0].onerror).toBeNull();
  expect(images[0].removeAttribute).toHaveBeenCalledWith('src');
  expect(target.context.drawImage).not.toHaveBeenCalled();
});

it('chooses an integer scale large enough for sparse symbols and omits fixed width', async () => {
  mockImage();
  vi.mocked(QRCode.create).mockReturnValueOnce({ modules: { size: 21 } } as ReturnType<typeof QRCode.create>);
  await renderConnectQr(canvas().canvas, '{}');
  const options = vi.mocked(QRCode.toCanvas).mock.calls[0][2];
  expect(options).toMatchObject({ scale: 13, margin: 4 });
  expect(options).not.toHaveProperty('width');
});
