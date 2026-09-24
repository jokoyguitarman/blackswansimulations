/**
 * Open a URL that has to be fetched first in a new tab. The tab is opened synchronously in the
 * click handler, because pop-up blockers refuse window.open after an await.
 */
export async function openInNewTab(getUrl: () => Promise<string>): Promise<void> {
  const tab = window.open('', '_blank');
  if (tab) tab.opener = null;
  try {
    const url = await getUrl();
    if (tab) tab.location.href = url;
    else window.location.assign(url);
  } catch (err) {
    tab?.close();
    throw err;
  }
}

/** Open a Blob (e.g. a generated PDF) in a new tab; the object URL is released after a while. */
export function openBlobInNewTab(getBlob: () => Promise<Blob>): Promise<void> {
  return openInNewTab(async () => {
    const url = URL.createObjectURL(await getBlob());
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return url;
  });
}
