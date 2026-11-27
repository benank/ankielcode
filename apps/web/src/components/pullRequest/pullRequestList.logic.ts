/** A label's host color as CSS, or null when the host gave none it can use. */
export function pullRequestLabelColor(color: string | null): string | null {
  const hex = color?.trim().replace(/^#/, "") ?? "";
  return /^[0-9a-fA-F]{6}$/.test(hex) ? `#${hex}` : null;
}
