// A docked panel uses the workbench document. A native tool window keeps the same React
// tree and API owner, with a new document for painting, geometry, focus and DOM events.
import { createContext, useContext } from 'react';

export const SurfaceDocument = createContext<Document | null>(null);
export function useSurfaceDocument(): Document {
  return useContext(SurfaceDocument) ?? document;
}
export function documentWindow(doc: Document): Window & typeof globalThis {
  return doc.defaultView ?? window;
}
