const sharePath = /^\/v1\/public\/shares(?:\/|\?|$)/;
const trackerPath = /^\/v1\/workspaces\/[^/]+\/(?:decisions|action-items)(?:\?|$)/;

export function isPublicSharePath(url: string): boolean {
  return sharePath.test(url);
}

export function privateRequestPath(url: string): string {
  if (isPublicSharePath(url)) return '/v1/public/shares/:token';
  if (trackerPath.test(url)) return url.split('?')[0]!;
  return url;
}

export function skipRequestLog(url: string): boolean {
  return isPublicSharePath(url) || trackerPath.test(url);
}
