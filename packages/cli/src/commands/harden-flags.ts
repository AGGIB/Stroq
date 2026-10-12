/** The yes-or-no options of `stroq harden`, read from the command line once. */
export interface HardenFlags {
  readonly json: boolean;
  /** Answers the question of `apply` and `undo`. There is no other way to run them without a terminal. */
  readonly yes: boolean;
  /** The owner has seen that the path is a link and that the change lands in the file it leads to. */
  readonly acknowledgeLink: boolean;
  /** The owner has seen that a value that looks like a credential is replaced and cannot be put back. */
  readonly acknowledgeCredentialLoss: boolean;
  /** The owner has seen that the change lays the whole file out again. */
  readonly acknowledgeReformat: boolean;
}
