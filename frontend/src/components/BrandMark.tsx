/**
 * The Black Swan logo.
 *
 * The source PNG is transparent with a near-black swan, so it needs the white
 * disc behind it to stay legible on the navy navigation bar.
 */
export const BrandMark = ({ className = 'h-9 w-9' }: { className?: string }) => (
  <img
    src="/brand/black-swan-logo.png"
    alt="Black Swan Simulations"
    className={`block shrink-0 rounded-full bg-white object-contain p-1 ring-1 ring-black/5 ${className}`}
  />
);
