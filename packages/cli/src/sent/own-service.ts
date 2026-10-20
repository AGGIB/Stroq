// Which service issued a key, where that service lives, and where the key is rotated.
//
// One table for three questions that used to have two (the report's rotate links and the
// card's provider labels), so the answers cannot drift apart. It is what tells a key used
// with its own service (an OpenAI key sent to api.openai.com, which is what the key is for)
// from the same key sent anywhere else, which is the finding that matters.
//
// A service's own hosts are the exact hosts it runs its API on, listed one by one: never a
// domain and every host under it, since a host under a service's domain can be anyone's (an S3
// bucket, a Supabase project, a Pages site, an app on a hosting service). A key sent to any host
// not listed went to another company. A service that keeps what it is sent (GitHub, GitLab,
// Bitbucket, Slack, Discord, Notion, Linear) publishes a key sent to it in a body.
//
// A key is placed by its NAME, whole words where a short name could be part of another
// (`NPM_TOKEN`, not `PNPM_HOME`), and by its source only where the source is the service's
// own file (`~/.aws/credentials`, `~/.npmrc`). Never by the folder a `.env` is in: a Stripe
// key in a folder called `GitHub` is a Stripe key.

/** What is known about the service behind a key. */
export interface Service {
  /** The label a card counts it under: chosen from this table, never taken from the key. */
  readonly label: string;
  /** The exact hosts of the service's own API the key is meant to be sent to. */
  readonly hosts: readonly string[];
  /** Where to revoke it, when the service is known and the address is checked. */
  readonly rotate: string | null;
  /**
   * The service keeps what it is sent (an issue, a gist, a message, a page): a key in the body of
   * a request to it is posted, not used.
   */
  readonly storesContent?: true;
  /** Headers besides `Authorization` and `x-api-key` the service reads a key from, lower case. */
  readonly authHeaders?: readonly string[];
  /** The query parameter the service documents for a key, when it has one. */
  readonly authQuery?: string;
}

interface Entry extends Service {
  readonly name: RegExp | null;
  /** The service's own credential file, as a report shows its path. */
  readonly file: string | null;
}

const entry = (
  label: string,
  name: RegExp | null,
  hosts: readonly string[],
  extra: {
    readonly file?: string;
    readonly rotate?: string;
    readonly storesContent?: true;
    readonly authHeaders?: readonly string[];
    readonly authQuery?: string;
  } = {},
): Entry => ({
  label,
  name,
  hosts,
  file: extra.file ?? null,
  rotate: extra.rotate ?? null,
  ...(extra.storesContent === true ? { storesContent: true as const } : {}),
  ...(extra.authHeaders === undefined ? {} : { authHeaders: extra.authHeaders }),
  ...(extra.authQuery === undefined ? {} : { authQuery: extra.authQuery }),
});

/** In order: the first entry whose name pattern matches wins, then the first whose file is the source. */
const SERVICES: readonly Entry[] = [
  entry(
    'AWS',
    /(?:^|[^a-z])(?:aws|amazon|boto)(?:[^a-z]|$)|(?:^|[_-])s3(?:[_-]|$)/i,
    ['sts.amazonaws.com', 'iam.amazonaws.com', 'signin.aws.amazon.com', 'console.aws.amazon.com'],
    {
      file: '.aws/credentials',
      rotate: 'https://console.aws.amazon.com/iam/home#/security_credentials',
    },
  ),
  // Not `githubusercontent.com`, `github.io` or `github.dev`: they serve what GitHub's users
  // wrote. GitHub keeps what its API is sent.
  entry(
    'GitHub',
    /github|(?:^|[_-])gh[a-z]?[_-]/i,
    [
      'github.com',
      'api.github.com',
      'uploads.github.com',
      'codeload.github.com',
      'ghcr.io',
      'npm.pkg.github.com',
      'maven.pkg.github.com',
      'nuget.pkg.github.com',
      'rubygems.pkg.github.com',
      'docker.pkg.github.com',
    ],
    { rotate: 'https://github.com/settings/tokens', storesContent: true },
  ),
  entry('GitLab', /gitlab/i, ['gitlab.com', 'registry.gitlab.com'], {
    storesContent: true,
    authHeaders: ['private-token'],
  }),
  entry('Bitbucket', /bitbucket/i, ['bitbucket.org', 'api.bitbucket.org'], {
    storesContent: true,
  }),
  // Before OpenAI: an Azure OpenAI key is an Azure resource's key.
  entry('Azure', /azure/i, [
    'management.azure.com',
    'login.microsoftonline.com',
    'graph.microsoft.com',
    'management.core.windows.net',
  ]),
  entry('OpenAI', /openai/i, ['api.openai.com'], {
    rotate: 'https://platform.openai.com/api-keys',
  }),
  entry('Anthropic', /anthropic|claude/i, ['api.anthropic.com'], {
    rotate: 'https://console.anthropic.com/settings/keys',
  }),
  entry('Stripe', /stripe/i, ['api.stripe.com', 'files.stripe.com', 'connect.stripe.com'], {
    rotate: 'https://dashboard.stripe.com/apikeys',
  }),
  entry(
    'Google',
    /google|gcp|gcloud|firebase|gemini/i,
    [
      'oauth2.googleapis.com',
      'accounts.google.com',
      'generativelanguage.googleapis.com',
      'aiplatform.googleapis.com',
      'iamcredentials.googleapis.com',
      'sts.googleapis.com',
      'identitytoolkit.googleapis.com',
      'securetoken.googleapis.com',
      'firebase.googleapis.com',
      'maps.googleapis.com',
    ],
    { authHeaders: ['x-goog-api-key'], authQuery: 'key' },
  ),
  entry('npm', /(?:^|[^a-z])npm(?:[^a-z]|$)|_authtoken/i, ['registry.npmjs.org'], {
    file: '.npmrc',
    rotate: 'https://www.npmjs.com/settings/~/tokens',
  }),
  entry(
    'Docker',
    /docker/i,
    ['index.docker.io', 'registry-1.docker.io', 'auth.docker.io', 'hub.docker.com'],
    { file: '.docker/config.json' },
  ),
  // A webhook (`hooks.slack.com/services/…`) posts into whichever workspace made it.
  entry('Slack', /slack/i, ['slack.com', 'api.slack.com', 'files.slack.com'], {
    storesContent: true,
  }),
  entry('Discord', /discord/i, ['discord.com', 'discordapp.com'], { storesContent: true }),
  entry('Notion', /notion/i, ['api.notion.com'], { storesContent: true }),
  entry('Linear', /(?:^|[^a-z])linear(?:[^a-z]|$)/i, ['api.linear.app'], { storesContent: true }),
  entry('Twilio', /twilio/i, ['api.twilio.com']),
  entry('Twilio', /sendgrid/i, ['api.sendgrid.com']),
  // A hosting service's own hosts are its API and its dashboard, never the hosts it serves its
  // customers' apps, repositories and buckets from.
  entry('Supabase', /supabase/i, ['api.supabase.com'], { authHeaders: ['apikey'] }),
  entry('Hosting', /vercel/i, ['api.vercel.com']),
  entry('Hosting', /netlify/i, ['api.netlify.com', 'app.netlify.com']),
  entry('Hosting', /cloudflare/i, ['api.cloudflare.com']),
  entry('Hosting', /heroku/i, ['api.heroku.com', 'id.heroku.com']),
  entry('Hosting', /digitalocean/i, ['api.digitalocean.com']),
  // Each project sends its events to an address of its own under `ingest.sentry.io`.
  entry('Monitoring', /sentry/i, ['sentry.io']),
  entry('Monitoring', /datadog/i, ['api.datadoghq.com', 'api.datadoghq.eu'], {
    authHeaders: ['dd-api-key'],
  }),
  entry('Monitoring', /newrelic/i, ['api.newrelic.com', 'api.eu.newrelic.com']),
  entry('Database', /postgres|mysql|mongo|redis|database|(?:^|[_-])db[_-]/i, []),
  entry('SSH or a private key', /ssh|private[_-]?key|\.pem|rsa|ed25519/i, []),
];

const OTHER: Service = { label: 'Other', hosts: [], rotate: null };
/** A canary planted with `stroq canary`: no service issued it, and it has nothing to rotate. */
const CANARY: Service = { label: 'Stroq canary', hosts: [], rotate: null };

/** Every label a key can be filed under: the only service names a card or `--counts` may hold. */
export const SERVICE_LABELS: ReadonlySet<string> = new Set([
  ...SERVICES.map((s) => s.label),
  OTHER.label,
  CANARY.label,
]);

/** The name and the source of a key: all a lookup here reads. Never the value. */
export interface KeyLabel {
  readonly name: string;
  readonly source: string;
  readonly canary?: true;
}

/** Whether a display path is the service file `file` (`~/.npmrc`, or a path that ends in it). */
function isFile(source: string, file: string): boolean {
  const path = source.replace(/\\/g, '/');
  return path === `~/${file}` || path.endsWith(`/${file}`);
}

/** The service behind a key, or `Other` when nothing in this table says. */
export function providerOf(key: KeyLabel): Service {
  if (key.canary === true) return CANARY;
  return (
    SERVICES.find((s) => s.name?.test(key.name) === true) ??
    SERVICES.find((s) => s.file !== null && isFile(key.source, s.file)) ??
    OTHER
  );
}

export const rotateUrl = (key: KeyLabel): string | null => providerOf(key).rotate;

/**
 * The host a `.netrc` password or a Docker credential names, in `name (host)`: the one host a
 * key from those files is for, whichever service runs it.
 */
function namedHost(key: KeyLabel): string | null {
  if (!isFile(key.source, '.netrc') && !isFile(key.source, '.docker/config.json')) return null;
  const open = key.name.lastIndexOf('(');
  if (open < 0 || !key.name.endsWith(')')) return null;
  const inside = key.name.slice(open + 1, -1).trim();
  try {
    return new URL(inside.includes('://') ? inside : `https://${inside}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

const clean = (host: string): string => host.toLowerCase().replace(/\.$/, '');

/** Whether sending this key to `host` is using it with the service it belongs to: an exact host. */
export function isOwnHost(key: KeyLabel, host: string): boolean {
  const target = clean(host);
  if (target === '') return false;
  if (namedHost(key) === target) return true;
  return providerOf(key).hosts.includes(target);
}

/** Whether the key's service keeps what it is sent: a key in a body to it is published there. */
export const storesContent = (key: KeyLabel): boolean => providerOf(key).storesContent === true;

/** The headers a key may be sent in to its own service, lower case. */
export const authHeaderNames = (key: KeyLabel): readonly string[] => [
  'authorization',
  'x-api-key',
  ...(providerOf(key).authHeaders ?? []),
];

/** The query parameter the key's service documents for it, or null when it documents none. */
export const authQueryParam = (key: KeyLabel): string | null => providerOf(key).authQuery ?? null;
