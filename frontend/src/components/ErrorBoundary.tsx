import { Component, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: unknown) {
    console.error('Error caught by boundary:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center p-4">
          <div className="max-w-md w-full bg-surface border border-border rounded-2xl shadow-lg p-6 relative z-10">
            <div className="text-xl font-extrabold text-danger mb-4 text-center">
              Something went wrong
            </div>
            <div className="border-l-4 border-danger bg-danger/10 p-4 mb-4 rounded-md">
              <p className="text-sm text-danger">
                {this.state.error?.message || 'An unexpected error occurred'}
              </p>
            </div>
            {this.state.error?.message?.includes('Supabase') && (
              <div className="border-l-4 border-accent bg-accent/10 p-4 mb-4 rounded-md">
                <p className="text-xs font-semibold text-accent mb-2 uppercase tracking-wide">
                  Missing Supabase configuration
                </p>
                <p className="text-xs text-muted mb-2">
                  Create{' '}
                  <code className="bg-surface-2 border border-border rounded px-1">
                    frontend/.env.local
                  </code>
                  :
                </p>
                <pre className="text-xs font-mono bg-surface-2 p-2 rounded border border-border overflow-x-auto text-ink">
                  {`VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key-here`}
                </pre>
              </div>
            )}
            <button
              onClick={() => window.location.reload()}
              className="w-full military-button py-2 px-4"
            >
              Reload
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
