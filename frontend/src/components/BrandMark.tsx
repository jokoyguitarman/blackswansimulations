/**
 * The Prophyion mark.
 *
 * Rendered as the brand tile (navy rounded square, cream bishop with the
 * diagonal slit, amber arcs) so it reads the same on the navy navigation bar
 * and on light surfaces. Source assets live in /public/brand; the kit is in
 * docs/brand.
 */
export const BrandMark = ({ className = 'h-9 w-9' }: { className?: string }) => (
  <img
    src="/brand/prophyion-tile.svg"
    alt="Prophyion"
    className={`block shrink-0 object-contain ${className}`}
  />
);
