import { createClient } from '@supabase/supabase-js';
import { getDeviceId } from './deviceId';

export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL || 'https://pzeoilvqeyuheslkfhjq.supabase.co',
  import.meta.env.VITE_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB6ZW9pbHZxZXl1aGVzbGtmaGpxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgzNDM2MjEsImV4cCI6MjA5MzkxOTYyMX0.f9ewqw57exbpvMcG_SUgXPytztDC08oeSFe3DTC9atc',
  // x-device-id scopes every request to this browser's own sessions/messages
  // via Postgres RLS (see the migration this ships with) - there is no login
  // system, so this per-device id is what stands in for a user identity.
  { global: { headers: { 'x-device-id': getDeviceId() } } }
);
