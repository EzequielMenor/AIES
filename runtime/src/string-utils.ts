/**
 * Truncate a string to a maximum length, adding an ellipsis if truncated.
 */
export function truncate(str: string, maxLength: number, ellipsis = '...'): string {
  if (str.length <= maxLength) return str;
  if (maxLength <= ellipsis.length) return ellipsis.slice(0, maxLength);
  return str.slice(0, maxLength - ellipsis.length) + ellipsis;
}
