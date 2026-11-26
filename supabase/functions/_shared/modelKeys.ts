// Which stored model addresses are safe to keep in a chat.
//
// Every build is first exported to a key shared by its build slot (for example
// models/c21f969b/model.ifc), and the next build in that slot overwrites it.
// A chat must only ever point at the copy made for its own build
// (models/<job uuid>/model.ifc) or at a review copy (models/review-<id>/).

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True for a model address on a shared build-slot key, which may now hold someone else's model. */
export function isSharedSlotModelUrl(raw: string | null | undefined): boolean {
  if (!raw) return false;
  try {
    const u = new URL(raw);
    if (!/\.amazonaws\.com$/i.test(u.hostname)) return false;
    const m = u.pathname.match(/(?:^|\/)models\/([^/]+)\/model\.ifc$/);
    if (!m) return false;
    const folder = m[1];
    return !(UUID.test(folder) || folder.startsWith("review-"));
  } catch {
    return false;
  }
}

export const SHARED_MODEL_MESSAGE =
  "This chat's model is stored in an old shared location that later builds overwrite, so it may no longer be your model. " +
  "I will not edit it, because that could change someone else's model. " +
  "To keep working on it: download the model, check that it is yours, upload it with the upload button, and continue in that new chat. " +
  "Or start a new build.";
