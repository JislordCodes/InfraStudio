/**
 * Address of the InfraStudio backend API (runs on the build box behind HTTPS).
 *
 * VITE_EDGE_PROXY_BASE can override it for local testing. A leftover value that still points
 * at an AWS Lambda Function URL or at the previous build box (both dead) is ignored, so a stale
 * setting in the hosting dashboard can never send the app to a backend that no longer exists.
 */
const DEFAULT_BACKEND = "https://13-63-78-238.nip.io";
const DEAD_BACKENDS = /lambda-url\.[a-z0-9-]+\.on\.aws|56-228-86-56\.nip\.io/i;

const configured = (import.meta.env.VITE_EDGE_PROXY_BASE as string | undefined)?.trim().replace(/\/+$/, "");

export const BACKEND_BASE: string =
  configured && !DEAD_BACKENDS.test(configured) ? configured : DEFAULT_BACKEND;
