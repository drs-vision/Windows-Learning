/** Bundled content lives at <install>/content. Inside the Windows shell that's https://coinquest.local/content; in dev, ./content. */
export function contentUrl(path: string): string {
  return location.host === 'coinquest.local' ? `https://coinquest.local/content/${path}` : `./content/${path}`;
}
