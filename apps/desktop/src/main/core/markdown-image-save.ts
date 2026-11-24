// A native chooser can outlive the workbench's input gesture. Its confirmation permits
// exactly the insertion it generated, for one CAS write, without authorizing any other IPC.
import { createHash } from 'node:crypto';
import type { WebContents } from 'electron';
import type { ImagePlacement } from '../../shared/markdown-images.js';
const lifetime = 7500;
interface Grant {
  session: string;
  path: string;
  page: number;
  revision: string;
  digest: string;
  until: number;
}
const grants = new WeakMap<WebContents, Grant>();
const hash = (text: string) => createHash('sha256').update(text, 'utf16le').digest('hex');
export function allowPickedInsertion(
  owner: WebContents,
  page: number,
  session: string,
  path: string,
  revision: string,
  target: ImagePlacement,
  markdown: string,
) {
  const value =
    target.text.slice(0, target.from) +
    markdown.replaceAll('\n', target.eol) +
    target.text.slice(target.to);
  grants.set(owner, {
    session,
    path,
    page,
    revision,
    digest: hash(value),
    until: performance.now() + lifetime,
  });
}
export function takePickedInsertion(
  owner: WebContents,
  page: number,
  session: string,
  path: string,
  revision: string | null,
  text: string,
) {
  const grant = grants.get(owner);
  if (!grant) return false;
  if (grant.page !== page || grant.until < performance.now()) {
    grants.delete(owner);
    return false;
  }
  if (
    grant.session !== session ||
    grant.path !== path ||
    grant.revision !== revision ||
    grant.digest !== hash(text)
  )
    return false;
  grants.delete(owner);
  return true;
}
