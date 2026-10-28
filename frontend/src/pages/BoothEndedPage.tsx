import { BrandMark } from '../components/BrandMark';

/** Where a booth visitor lands after 10 minutes without a tap (lib/boothVisitor.ts). */
export const BoothEndedPage = () => (
  <div className="min-h-screen flex items-center justify-center px-6">
    <div className="max-w-sm w-full bg-surface border border-border rounded-2xl shadow-lg p-8 text-center space-y-4">
      <BrandMark className="w-12 h-12 mx-auto" />
      <div className="text-xl font-extrabold text-ink">Your visit has ended</div>
      <p className="text-sm text-ink">
        After 10 minutes without a tap, we sign you out of the simulation.
      </p>
      <p className="text-sm text-muted">To play again, scan the QR code at the Prophyion booth.</p>
    </div>
  </div>
);
