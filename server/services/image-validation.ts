export const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'] as const);
export type AllowedImageMimeType = 'image/jpeg' | 'image/png' | 'image/webp';

export function detectImageMimeType(buffer: Buffer): AllowedImageMimeType | null {
  if (
    buffer.length >= 10 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff &&
    buffer.includes(Buffer.from([0xff, 0xda])) && buffer.at(-2) === 0xff && buffer.at(-1) === 0xd9
  ) return 'image/jpeg';
  if (
    buffer.length >= 45 &&
    buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) &&
    buffer.subarray(12, 16).toString('ascii') === 'IHDR' && buffer.readUInt32BE(16) > 0 && buffer.readUInt32BE(20) > 0 &&
    buffer.subarray(-12).equals(Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]))
  ) return 'image/png';
  if (
    buffer.length >= 20 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP' && buffer.readUInt32LE(4) + 8 === buffer.length &&
    ['VP8 ', 'VP8L', 'VP8X'].includes(buffer.subarray(12, 16).toString('ascii'))
  ) return 'image/webp';
  return null;
}
