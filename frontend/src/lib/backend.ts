/**
 * Address of the InfraStudio backend API (runs on the build box behind HTTPS).
 *
 * VITE_EDGE_PROXY_BASE can override it for local testing. A leftover value that still points
 * at an AWS Lambda Function URL (the old, now dead backend) is ignored, so a stale setting in the
 * hosting dashboard can never send the app to a backend that no longer exists.
 */
const DEFAULT_BACKEND = "https://56-228-86-56.nip.io";

const configured = (import.meta.env.VITE_EDGE_PROXY_BASE as string | undefined)?.trim().replace(/\/+$/, "");

export const BACKEND_BASE: string =
  configured && !/lambda-url\.[a-z0-9-]+\.on\.aws/i.test(configured) ? configured : DEFAULT_BACKEND;
