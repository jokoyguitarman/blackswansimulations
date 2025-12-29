import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || '';
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || '';

// Debug: Log what Vite is actually reading (in development only)
if (import.meta.env.DEV) {
  console.log('[DEBUG] Environment variables check:');
  console.log('VITE_SUPABASE_URL:', supabaseUrl ? `${supabaseUrl.substring(0, 20)}...` : 'MISSING');
  console.log(
    'VITE_SUPABASE_ANON_KEY:',
    supabaseAnonKey ? `${supabaseAnonKey.substring(0, 20)}...` : 'MISSING',
  );
}

// Check if values are missing or placeholders
const isPlaceholder =
  supabaseUrl.includes('your-supabase-url') ||
  supabaseAnonKey.includes('your-anon-key') ||
  supabaseUrl === '' ||
  supabaseAnonKey === '' ||
  supabaseUrl === 'https://placeholder.supabase.co' ||
  supabaseAnonKey === 'placeholder-key';

if (isPlaceholder) {
  const errorMsg = `
╔══════════════════════════════════════════════════════════════╗
║  ⚠️  MISSING SUPABASE CONFIGURATION                         ║
╠══════════════════════════════════════════════════════════════╣
║                                                              ║
║  Please create frontend/.env.local with:                    ║
║                                                              ║
║  VITE_SUPABASE_URL=https://your-project.supabase.co         ║
║  VITE_SUPABASE_ANON_KEY=your-anon-key-here                   ║
║                                                              ║
║  Get these from: Supabase Dashboard →                       ║
║  Project Settings → API                                     ║
║                                                              ║
║  Then restart the dev server!                               ║
╚══════════════════════════════════════════════════════════════╝
  `;

  console.error('%c' + errorMsg, 'color: #ef4444; font-weight: bold;');
}

// Export a flag to check if configuration is valid
export const isSupabaseConfigured = !isPlaceholder;

export const supabase = createClient(
  isPlaceholder ? 'https://placeholder.supabase.co' : supabaseUrl,
  isPlaceholder ? 'placeholder-key' : supabaseAnonKey,
  {
    auth: {
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: true,
    },
  },
);
