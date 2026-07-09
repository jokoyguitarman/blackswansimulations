import { isSupabaseConfigured } from '../lib/supabase';

/**
 * Component that shows an error if Supabase is not configured
 */
export function SupabaseConfigError() {
  if (isSupabaseConfigured) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4">
      <div className="max-w-2xl w-full bg-surface border border-border rounded-2xl shadow-lg p-8 relative z-10">
        <div className="text-2xl font-extrabold text-danger mb-4 text-center">
          Configuration error
        </div>

        <div className="space-y-4">
          <div className="border-l-4 border-danger bg-danger/10 p-4 rounded-md">
            <h1 className="text-lg font-bold text-danger mb-2">Missing Supabase configuration</h1>
            <p className="text-sm text-ink">
              The application cannot connect to Supabase because environment variables are missing
              or contain placeholder values.
            </p>
          </div>

          <div className="border-l-4 border-accent bg-accent/10 p-4 rounded-md">
            <h2 className="text-sm font-bold text-accent uppercase tracking-wide mb-2">
              Setup instructions
            </h2>
            <ol className="text-xs text-muted space-y-2 list-decimal list-inside">
              <li>
                Create a file named{' '}
                <code className="bg-surface border border-border rounded px-1">.env.local</code> in
                the <code className="bg-surface border border-border rounded px-1">frontend/</code>{' '}
                directory
              </li>
              <li>Add the following lines (replace with your actual values):</li>
            </ol>
            <pre className="mt-3 text-xs font-mono bg-surface-2 p-3 rounded border border-border overflow-x-auto text-ink">
              {`VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key-here`}
            </pre>
            <p className="mt-3 text-xs text-muted">
              Get these values from: <strong>Supabase Dashboard → Project Settings → API</strong>
            </p>
          </div>

          <div className="border-l-4 border-brand bg-brand/10 p-4 rounded-md">
            <h2 className="text-sm font-bold text-brand uppercase tracking-wide mb-2">
              Restart required
            </h2>
            <p className="text-xs text-muted">
              After creating/updating{' '}
              <code className="bg-surface border border-border rounded px-1">.env.local</code>, you
              must restart the Vite dev server for changes to take effect.
            </p>
            <p className="text-xs text-muted mt-2">
              Stop the server (Ctrl+C) and run{' '}
              <code className="bg-surface border border-border rounded px-1">npm run dev</code>{' '}
              again.
            </p>
          </div>

          <div className="text-center mt-6">
            <button onClick={() => window.location.reload()} className="px-6 py-2 military-button">
              Reload page
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
