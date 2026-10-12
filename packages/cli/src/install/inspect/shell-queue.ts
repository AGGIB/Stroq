// Shell text found by the readers, waiting to be read by the shell classifier.
//
// A fenced block in a README, a hook in front matter, a lifecycle script of a package and a file of
// shell all end the same way: text that a shell would be given. The readers that find such text only
// put it here, with the place it was found, and one pass at the end reads all of it under one budget.
// So the cost of reading shell does not depend on how many places an artifact scatters it in.

export type SnippetOrigin =
  /** A block in a document: an example, which may or may not be run. */
  | 'doc'
  /** A hook a skill or plugin declares, which the host runs. */
  | 'hook'
  /** A file of shell, or a script a package runs. */
  | 'script'
  /** A script of a package that is not run when it is installed. */
  | 'package-script';

export interface ShellSnippet {
  readonly file: string;
  readonly line: number;
  readonly text: string;
  readonly origin: SnippetOrigin;
}

export class ShellQueue {
  private readonly queued: ShellSnippet[] = [];

  add(snippet: ShellSnippet): void {
    if (snippet.text.trim() !== '') this.queued.push(snippet);
  }

  /** What was queued, in an order that does not depend on the order it was found in. */
  snippets(): readonly ShellSnippet[] {
    return [...this.queued].sort(
      (a, b) =>
        (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) ||
        a.line - b.line ||
        (a.origin < b.origin ? -1 : a.origin > b.origin ? 1 : 0),
    );
  }
}
