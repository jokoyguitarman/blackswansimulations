/**
 * The Prophyion mark.
 *
 * Rendered as the brand tile (navy rounded square; cream rook with the pawn cut
 * out of it, amber base) so it reads the same on the navy navigation bar and on
 * light surfaces without needing a backing disc. Source assets live in
 * /public/brand; the full kit is in docs/brand.
 */
export const BrandMark = ({ className = 'h-9 w-9' }: { className?: string }) => (
  <img
    src="/brand/prophyion-tile.svg"
    alt="Prophyion"
    className={`block shrink-0 object-contain ${className}`}
  />
);
