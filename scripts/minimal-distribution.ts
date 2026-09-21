/** Reject dependency protocols without mistaking identifiers such as createLink for one. */
export function forbiddenDistributionReference(text: string, sourceRoot: string): string | undefined {
  const normalized = text.toLowerCase().replaceAll('\\', '/')
  const protocol = /(?:^|[^a-z0-9_$])((?:workspace|link):)/.exec(normalized)
  if (protocol) return protocol[1]
  const root = sourceRoot.toLowerCase().replaceAll('\\', '/')
  return normalized.includes(root) ? root : undefined
}
