import crypto from 'crypto';

const TOKEN_VERSION = 'v1';

function secret(): string {
  return process.env.MEDIA_PUBLIC_TOKEN_SECRET || '';
}

function signature(mediaId: string): string {
  return crypto.createHmac('sha256', secret()).update(`${TOKEN_VERSION}:${mediaId}`).digest('hex');
}

export function buildPublicMediaUrl(mediaId: string): string | null {
  const baseUrl = (process.env.MEDIA_PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
  if (!baseUrl || !secret() || !/^https?:\/\//i.test(baseUrl) || !mediaId) return null;
  return `${baseUrl}/api/media/public/${encodeURIComponent(mediaId)}?token=${signature(mediaId)}`;
}

export function verifyPublicMediaToken(mediaId: string, token: string): boolean {
  if (!mediaId || !token || !secret()) return false;
  const expected = Buffer.from(signature(mediaId), 'hex');
  let actual: Buffer;
  try { actual = Buffer.from(token, 'hex'); } catch { return false; }
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}
