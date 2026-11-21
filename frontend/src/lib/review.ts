import { strToU8, zipSync } from 'fflate';
import { BACKEND_BASE } from './backend';

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

async function call(body: Record<string, unknown>): Promise<Review> {
  const res = await fetch(`${BACKEND_BASE}/review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.status !== 'success') throw new Error(data?.error || `The review service returned ${res.status}.`);
  return data.review as Review;
}

export const createReview = (ifcUrl: string, title: string, project: string) =>
  call({ action: 'create', ifc_url: ifcUrl, title, project });

export const getReview = (id: string) => call({ action: 'get', id });

export const addComment = (
  id: string,
  c: { guid: string; elementName: string; cls: string; text: string; author: string },
) => call({ action: 'comment', id, ...c });

export const setResolved = (id: string, commentId: string, resolved: boolean) =>
  call({ action: 'resolve', id, commentId, resolved });

/** The link a client opens. It lives next to the app, so it keeps the app's base path. */
export function reviewLink(id: string): string {
  const url = new URL(window.location.href);
  url.search = '';
  url.hash = '';
  url.searchParams.set('review', id);
  return url.toString();
}

export function reviewIdFromLocation(): string | null {
  const id = new URL(window.location.href).searchParams.get('review');
  return id && /^[A-Za-z0-9_-]{12}$/.test(id) ? id : null;
}

/* ───────────────────────── BCF export ───────────────────────── */

const xmlEsc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const uuid = () => crypto.randomUUID();

/**
 * BCF 2.1 file: one topic per comment, each pointing at the commented element by its IFC GlobalId,
 * so Revit, Solibri, BIMcollab and others jump straight to it.
 */
export function buildBcf(review: Review, elementCentres: Map<string, [number, number, number]>): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  files['bcf.version'] = strToU8(
    '<?xml version="1.0" encoding="UTF-8"?>\n<Version VersionId="2.1" xsi:noNamespaceSchemaLocation="version.xsd" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><DetailedVersion>2.1</DetailedVersion></Version>',
  );
  files['project.bcfp'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8"?>\n<ProjectExtension xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><Project ProjectId="${uuid()}"><Name>${xmlEsc(review.project || review.title)}</Name></Project><ExtensionSchema></ExtensionSchema></ProjectExtension>`,
  );

  for (const c of review.comments) {
    const topic = uuid();
    const commentId = uuid();
    const viewpoint = uuid();
    const title = c.text.replace(/\s+/g, ' ').slice(0, 80);
    const markup = `<?xml version="1.0" encoding="UTF-8"?>
<Markup xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">
  <Header><File IsExternal="false"><Filename>${xmlEsc((review.project || review.title || 'model') + '.ifc')}</Filename><Date>${review.created}</Date></File></Header>
  <Topic Guid="${topic}" TopicType="Comment" TopicStatus="${c.resolved ? 'Closed' : 'Open'}">
    <Title>${xmlEsc(title)}</Title>
    <CreationDate>${c.created}</CreationDate>
    <CreationAuthor>${xmlEsc(c.author)}</CreationAuthor>
    <Description>${xmlEsc(`${c.elementName || c.cls}: ${c.text}`)}</Description>
  </Topic>
  <Comment Guid="${commentId}">
    <Date>${c.created}</Date>
    <Author>${xmlEsc(c.author)}</Author>
    <Comment>${xmlEsc(c.text)}</Comment>
    <Viewpoint Guid="${viewpoint}"/>
  </Comment>
  <Viewpoints Guid="${viewpoint}"><Viewpoint>viewpoint.bcfv</Viewpoint></Viewpoints>
</Markup>`;
    const centre = elementCentres.get(c.guid);
    const camera = centre
      ? `<PerspectiveCamera>
    <CameraViewPoint><X>${(centre[0] + 12).toFixed(3)}</X><Y>${(centre[1] - 12).toFixed(3)}</Y><Z>${(centre[2] + 8).toFixed(3)}</Z></CameraViewPoint>
    <CameraDirection><X>-0.577</X><Y>0.577</Y><Z>-0.577</Z></CameraDirection>
    <CameraUpVector><X>0</X><Y>0</Y><Z>1</Z></CameraUpVector>
    <FieldOfView>60</FieldOfView>
  </PerspectiveCamera>`
      : '';
    const vp = `<?xml version="1.0" encoding="UTF-8"?>
<VisualizationInfo Guid="${viewpoint}">
  <Components>
    <Selection>${c.guid ? `<Component IfcGuid="${xmlEsc(c.guid)}"/>` : ''}</Selection>
    <Visibility DefaultVisibility="true"/>
  </Components>
  ${camera}
</VisualizationInfo>`;
    files[`${topic}/markup.bcf`] = strToU8(markup);
    files[`${topic}/viewpoint.bcfv`] = strToU8(vp);
  }
  return zipSync(files);
}

export function downloadBlob(bytes: Uint8Array | Blob, filename: string, type: string): void {
  const blob = bytes instanceof Blob ? bytes : new Blob([bytes as BlobPart], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
