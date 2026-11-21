/**
 * Shared review links. A review is a frozen copy of a model plus the comments people pin to
 * its elements. Anyone with the link can read the model and add comments. Nothing else is
 * reachable, and the link id is random, so a link cannot be guessed.
 *
 * Storage is S3 only:
 *   models/review-<id>/model.ifc   the frozen model (same public prefix as every other model)
 *   reviews/<id>.json              title, project and comments (private, served through this API)
 */
import { randomBytes } from "node:crypto";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

const REGION = process.env.AWS_REGION || "eu-north-1";
const BUCKET = process.env.REVIEW_BUCKET || "infrastudio-ifc-models-343262620843";
const s3 = new S3Client({ region: REGION });

const MAX_MODEL_BYTES = 120 * 1024 * 1024;
const MAX_COMMENTS = 500;
const MAX_TEXT = 2000;
const ID_RE = /^[A-Za-z0-9_-]{12}$/;

export interface ReviewComment {
  id: string;
  guid: string;
  elementName: string;
  cls: string;
  text: string;
  author: string;
  created: string;
  resolved: boolean;
}

export interface Review {
  id: string;
  title: string;
  project: string;
  created: string;
  modelUrl: string;
  comments: ReviewComment[];
}

/** Models may only be copied from our own bucket or our own file storage, never from arbitrary hosts. */
function allowedSource(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return false;
    return u.hostname.endsWith(".amazonaws.com") || u.hostname.endsWith(".supabase.co");
  } catch {
    return false;
  }
}

const locks = new Map<string, Promise<unknown>>();
/** Runs tasks for one review one after another, so two comments never overwrite each other. */
async function serial<T>(id: string, task: () => Promise<T>): Promise<T> {
  const prev = locks.get(id) ?? Promise.resolve();
  const next = prev.then(task, task);
  locks.set(id, next.catch(() => undefined));
  return next;
}

async function readReview(id: string): Promise<Review | null> {
  try {
    const out = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: `reviews/${id}.json` }));
    return JSON.parse(await out.Body!.transformToString()) as Review;
  } catch (e: any) {
    if (e?.name === "NoSuchKey" || e?.$metadata?.httpStatusCode === 404) return null;
    throw e;
  }
}

async function writeReview(r: Review): Promise<void> {
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: `reviews/${r.id}.json`,
    Body: JSON.stringify(r),
    ContentType: "application/json",
  }));
}

const clean = (s: unknown, max: number): string => String(s ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim().slice(0, max);

export async function handleReview(payload: any): Promise<any> {
  const action = String(payload?.action || "");

  if (action === "create") {
    const src = String(payload.ifc_url || "");
    if (!allowedSource(src)) return { status: "error", error: "That model cannot be shared." };
    const res = await fetch(src);
    if (!res.ok) return { status: "error", error: `Could not read the model (${res.status}).` };
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_MODEL_BYTES) return { status: "error", error: "The model is empty or too large to share." };
    const id = randomBytes(9).toString("base64url").slice(0, 12);
    const key = `models/review-${id}/model.ifc`;
    await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: bytes, ContentType: "application/octet-stream" }));
    const review: Review = {
      id,
      title: clean(payload.title, 120) || "Shared model",
      project: clean(payload.project, 120),
      created: new Date().toISOString(),
      modelUrl: `https://${BUCKET}.s3.${REGION}.amazonaws.com/${key}`,
      comments: [],
    };
    await writeReview(review);
    return { status: "success", review };
  }

  const id = String(payload?.id || "");
  if (!ID_RE.test(id)) return { status: "error", error: "That review link is not valid." };

  if (action === "get") {
    const review = await readReview(id);
    return review ? { status: "success", review } : { status: "error", error: "That review was not found." };
  }

  if (action === "comment") {
    const text = clean(payload.text, MAX_TEXT);
    if (!text) return { status: "error", error: "Write a comment first." };
    return serial(id, async () => {
      const review = await readReview(id);
      if (!review) return { status: "error", error: "That review was not found." };
      if (review.comments.length >= MAX_COMMENTS) return { status: "error", error: "This review has reached its comment limit." };
      const comment: ReviewComment = {
        id: randomBytes(6).toString("base64url"),
        guid: clean(payload.guid, 40),
        elementName: clean(payload.elementName, 160),
        cls: clean(payload.cls, 60),
        text,
        author: clean(payload.author, 60) || "Guest",
        created: new Date().toISOString(),
        resolved: false,
      };
      review.comments.push(comment);
      await writeReview(review);
      return { status: "success", review };
    });
  }

  if (action === "resolve") {
    return serial(id, async () => {
      const review = await readReview(id);
      if (!review) return { status: "error", error: "That review was not found." };
      const c = review.comments.find((x) => x.id === String(payload.commentId));
      if (!c) return { status: "error", error: "That comment was not found." };
      c.resolved = payload.resolved !== false;
      await writeReview(review);
      return { status: "success", review };
    });
  }

  return { status: "error", error: "Unknown review action." };
}
