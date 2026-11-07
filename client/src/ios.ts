/**
 * The iOS version an iPhone or iPad user agent names, such as 15.8, or null for anything else.
 * An iPad that asks for desktop sites reports itself as a Mac with no iOS version, so it gets null.
 */
export function iosVersion(userAgent: string): number | null {
  const match = /OS (\d+)_(\d+)[_\d]* like Mac OS X/.exec(userAgent);
  // major.minor as a decimal sorts right because no iOS 16 release, where 16.4 is the line, has a minor above 9.
  return match ? Number(`${match[1]}.${match[2]}`) : null;
}

/** iOS before 16.4, which has no Web Push even from the home screen, so alerts go through Bark (D-054). */
export function isOldIos(userAgent: string): boolean {
  return (iosVersion(userAgent) ?? Infinity) < 16.4;
}
