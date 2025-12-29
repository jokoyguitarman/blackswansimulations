import { isSupabaseConfigured } from '../lib/supabase';

/**
 * Component that shows an error if Supabase is not configured
 */
export function SupabaseConfigError() {
  if (isSupabaseConfigured) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black scanline p-4">
      <div className="max-w-2xl w-full military-border bg-black/90 p-8 border-red-500 relative z-10">
        <div className="classified-stamp text-4xl mb-4 text-center">CONFIGURATION ERROR</div>

        <div className="space-y-4">
          <div className="border-l-4 border-red-500 bg-red-900/20 p-4">
            <h1 className="text-xl terminal-text text-red-500 mb-2 uppercase tracking-wider">
              [ERROR] Missing Supabase Configuration
            </h1>
            <p className="text-sm terminal-text text-red-400">
              The application cannot connect to Supabase because environment variables are missing
              or contain placeholder values.
            </p>
          </div>

          <div className="military-border bg-yellow-900/20 border-yellow-500 p-4">
            <h2 className="text-sm terminal-text text-yellow-400 uppercase mb-2">
              [ACTION_REQUIRED] Setup Instructions
            </h2>
            <ol className="text-xs terminal-text text-yellow-400/70 space-y-2 list-decimal list-inside">
              <li>
                Create a file named <code className="bg-black/50 px-1">.env.local</code> in the{' '}
                <code className="bg-black/50 px-1">frontend/</code> directory
              </li>
              <li>Add the following lines (replace with your actual values):</li>
            </ol>
            <pre className="mt-3 text-xs terminal-text bg-black p-3 border border-yellow-500/50 overflow-x-auto text-yellow-400">
              {`VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key-here`}
            </pre>
            <p className="mt-3 text-xs terminal-text text-yellow-400/70">
              Get these values from: <strong>Supabase Dashboard → Project Settings → API</strong>
            </p>
          </div>

          <div className="military-border bg-blue-900/20 border-blue-500 p-4">
            <h2 className="text-sm terminal-text text-blue-400 uppercase mb-2">
              [IMPORTANT] Restart Required
            </h2>
            <p className="text-xs terminal-text text-blue-400/70">
              After creating/updating <code className="bg-black/50 px-1">.env.local</code>, you must
              restart the Vite dev server for changes to take effect.
            </p>
            <p className="text-xs terminal-text text-blue-400/50 mt-2">
              Stop the server (Ctrl+C) and run <code className="bg-black/50 px-1">npm run dev</code>{' '}
              again.
            </p>
          </div>

          <div className="text-center mt-6">
            <button
              onClick={() => window.location.reload()}
              className="px-6 py-2 military-button border-yellow-500 text-yellow-500 hover:bg-yellow-500/10"
            >
              [RELOAD_PAGE]
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
