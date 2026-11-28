export const CATALOG_RETURN_PATH = "/settings/projects/connect/return";

let registration: { state: string; code: string } | null = null;

/** Run before auth or routing can save a return URL. Keep the one-use proof in memory only. */
export function captureCatalogReturn() {
  if (location.pathname !== CATALOG_RETURN_PATH || !location.search) return;
  const params = new URLSearchParams(location.search);
  const state = params.get("state");
  const code = params.get("code");
  history.replaceState(history.state, "", CATALOG_RETURN_PATH);
  if (state && code) registration = { state, code };
}

export function takeCatalogReturn() {
  const proof = registration;
  registration = null;
  return proof;
}
