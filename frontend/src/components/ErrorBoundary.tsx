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
        <div className="min-h-screen flex items-center justify-center scanline p-4">
          <div
            className="absolute inset-0 opacity-10"
            style={{
              backgroundImage:
                'linear-gradient(rgba(255, 107, 53, 0.1) 1px, transparent 1px), linear-gradient(90deg, rgba(255, 107, 53, 0.1) 1px, transparent 1px)',
              backgroundSize: '50px 50px',
            }}
          ></div>
          <div className="max-w-md w-full military-border p-6 relative z-10 border-robotic-orange">
            <div className="classified-stamp text-xl mb-4 text-center">SYSTEM ERROR</div>
            <h1 className="text-xl terminal-text text-robotic-orange mb-4 uppercase tracking-wider text-center">
              [CRITICAL_FAILURE]
            </h1>
            <div className="border-l-4 border-robotic-orange bg-robotic-orange/20 p-4 mb-4">
              <p className="text-sm terminal-text text-robotic-orange">
                {this.state.error?.message || '[ERROR] An unexpected error occurred'}
              </p>
            </div>
            {this.state.error?.message?.includes('Supabase') && (
              <div className="military-border bg-robotic-yellow/20 border-robotic-yellow p-4 mb-4">
                <p className="text-xs terminal-text text-robotic-yellow font-semibold mb-2 uppercase">
                  [CONFIG_ERROR] Missing Supabase Configuration
                </p>
                <p className="text-xs terminal-text text-robotic-yellow/70 mb-2">
                  Create <code className="bg-robotic-gray-300/50 px-1">frontend/.env.local</code>:
                </p>
                <pre className="text-xs terminal-text bg-robotic-gray-300 p-2 border border-robotic-yellow/50 overflow-x-auto text-robotic-yellow">
                  {`VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key-here`}
                </pre>
              </div>
            )}
            <button
              onClick={() => window.location.reload()}
              className="w-full military-button py-2 px-4"
            >
              [RELOAD_SYSTEM]
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
