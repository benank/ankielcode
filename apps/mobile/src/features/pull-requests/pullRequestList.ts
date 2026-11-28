export function pullRequestLabelColor(color: string | null) {
  const hex = color?.replace(/^#/, "");
  return hex && /^[\da-f]{6}$/i.test(hex) ? `#${hex}` : null;
}
