const DEVICE_ID_KEY = 'infrastudio_device_id';

/**
 * A random id persisted in this browser's localStorage, acting as the
 * "device identity" for scoping session/chat visibility - there is no login
 * system, so this unguessable value (not the user's IP, which is shared
 * across NAT/office wifi and rotates on mobile) is what Postgres RLS checks
 * against on every request, sent as the x-device-id header (see lib/supabase.ts).
 */
export function getDeviceId(): string {
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : `dev-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    localStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
}
