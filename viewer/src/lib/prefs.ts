const SKIP_UNMASKED_WARNING = "polars-telemetry-viewer.skip-unmasked-warning";

export function warnsUnmasked(): boolean {
  try {
    return localStorage.getItem(SKIP_UNMASKED_WARNING) !== "1";
  } catch {
    return true;
  }
}

export function stopWarningUnmasked(): void {
  try {
    localStorage.setItem(SKIP_UNMASKED_WARNING, "1");
  } catch {}
}
