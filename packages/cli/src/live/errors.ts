// The errors the live check throws on purpose, so that a caller can tell "you asked for something
// this check will not do" from a bug, by a code and not by the words of a message.

export type LiveErrorCode =
  /** A directory the check was asked to write in or delete from is not one it made for itself. */
  | 'unsafe-directory'
  /** An option or a value handed to the check is not one it can work with. */
  | 'invalid-option'
  /** The budget cannot be had: no file was named for it, or the file named is not a usable place. */
  | 'invalid-ledger';

export class LiveCheckError extends Error {
  readonly code: LiveErrorCode;

  constructor(code: LiveErrorCode, message: string) {
    super(message);
    this.name = 'LiveCheckError';
    this.code = code;
  }
}
