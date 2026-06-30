// Tiny classnames joiner — filters out falsy values. No external dep needed.
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}
