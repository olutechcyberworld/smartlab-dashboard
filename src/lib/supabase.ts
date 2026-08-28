import { createClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'

const supabaseUrl     = import.meta.env.VITE_SUPABASE_URL     as string
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    'VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY must be set in .env.local'
  )
}

export const supabase = createClient<Database>(supabaseUrl, supabaseAnonKey, {
  db: {
    schema: 'smart_attendance_system',
  },
  auth: {
    persistSession:   true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
})