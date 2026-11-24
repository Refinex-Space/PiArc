import type mermaid from 'mermaid';
declare global {
  interface Window {
    /** The offline Mermaid bundle installs this only inside the diagram sandbox. */
    readonly mermaid?: typeof mermaid;
  }
}
