// Which names of environment variables are credentials, or very likely carry one.
const CREDENTIAL_WORDS = /key|token|secret|password|passwd|credential/i;
const CREDENTIAL_PREFIX = /^(?:aws_|github_|openai_|anthropic_)/i;

export const looksLikeCredential = (name: string): boolean =>
  CREDENTIAL_WORDS.test(name) || CREDENTIAL_PREFIX.test(name);
