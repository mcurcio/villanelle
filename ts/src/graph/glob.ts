/**
 * Include glob rules shared by composeLoaders and the loaders of ./node and ./browser. Private to the package.
 */

/** Whether an include spec is a glob: it holds * or ?. */
export function hasGlob(spec: string): boolean {
  return /[*?]/.test(spec);
}
