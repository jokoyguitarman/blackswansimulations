/** The same rounding the review logs used: `Number(value.toFixed(digits))`. */
export function fixed(value: number, digits: number): number {
  return Number(value.toFixed(digits));
}
