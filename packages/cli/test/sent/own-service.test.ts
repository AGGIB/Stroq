import { describe, expect, it } from 'vitest';
import { isOwnHost, providerOf, rotateUrl, storesContent } from '../../src/sent/own-service.js';

describe('which service a key belongs to', () => {
  it.each([
    ['aws_secret_access_key', '~/.aws/credentials', 'AWS'],
    ['AWS_ACCESS_KEY_ID', '.env', 'AWS'],
    ['GITHUB_TOKEN', '.env', 'GitHub'],
    ['gh_token', 'env', 'GitHub'],
    ['OPENAI_API_KEY', '~/aws-infra/.env', 'OpenAI'],
    ['ANTHROPIC_API_KEY', '.env', 'Anthropic'],
    ['STRIPE_API_KEY', '~/GitHub/app/.env', 'Stripe'],
    ['npm_token', '~/.npmrc', 'npm'],
    ['//registry.npmjs.org/:_authToken', '~/.npmrc', 'npm'],
    ['auth', '~/.docker/config.json', 'Docker'],
    ['DATABASE_URL', '.env', 'Database'],
    ['id_ed25519', '~/.ssh/id_ed25519', 'SSH or a private key'],
    ['VERCEL_TOKEN', '.env', 'Hosting'],
    ['SENTRY_AUTH_TOKEN', '.env', 'Monitoring'],
    ['SOMETHING_ELSE', '.env', 'Other'],
  ])('%s from %s is %s', (name, source, label) => {
    expect(providerOf({ name, source }).label).toBe(label);
  });

  it('does not read pnpm as npm', () => {
    expect(providerOf({ name: 'PNPM_HOME_TOKEN', source: '.env' }).label).toBe('Other');
  });
});

describe('where a key is rotated', () => {
  it.each([
    ['STRIPE_API_KEY', '~/GitHub/app/.env', 'https://dashboard.stripe.com/apikeys'],
    ['OPENAI_API_KEY', '.env', 'https://platform.openai.com/api-keys'],
    ['ANTHROPIC_API_KEY', '.env', 'https://console.anthropic.com/settings/keys'],
    ['GITHUB_TOKEN', '.env', 'https://github.com/settings/tokens'],
    ['NPM_TOKEN', '.env', 'https://www.npmjs.com/settings/~/tokens'],
    ['_authToken', '~/.npmrc', 'https://www.npmjs.com/settings/~/tokens'],
    [
      'aws_secret_access_key',
      '~/.aws/credentials',
      'https://console.aws.amazon.com/iam/home#/security_credentials',
    ],
  ])('%s from %s: %s', (name, source, url) => {
    expect(rotateUrl({ name, source })).toBe(url);
  });

  it('has no link when nothing says which service issued the key', () => {
    expect(rotateUrl({ name: 'DATABASE_PASSWORD', source: '~/x/github-demo/.env' })).toBeNull();
  });
});

describe('a key sent to its own service', () => {
  it.each([
    ['OPENAI_API_KEY', '.env', 'api.openai.com', true],
    ['OPENAI_API_KEY', '.env', 'webhook.site', false],
    ['OPENAI_API_KEY', '.env', 'openai.com.evil.example', false],
    ['OPENAI_API_KEY', '.env', 'notopenai.com', false],
    ['GITHUB_TOKEN', 'env', 'api.github.com', true],
    ['STRIPE_SECRET_KEY', '.env', 'api.stripe.com', true],
    ['STRIPE_SECRET_KEY', '.env', 'api.openai.com', false],
    ['aws_secret_access_key', '~/.aws/credentials', 'sts.amazonaws.com', true],
    ['aws_secret_access_key', '~/.aws/credentials', 'console.aws.amazon.com', true],
    ['GOOGLE_MAPS_API_KEY', '.env', 'maps.googleapis.com', true],
    ['SUPABASE_ACCESS_TOKEN', '.env', 'api.supabase.com', true],
    ['password (api.example.test)', '~/.netrc', 'api.example.test', true],
    ['password (api.example.test)', '~/.netrc', 'other.example.test', false],
    ['password (example.test)', '~/.netrc', 'evil.example.test', false],
    [
      'docker password (https://index.docker.io/v1/)',
      '~/.docker/config.json',
      'index.docker.io',
      true,
    ],
    ['docker auth (registry.example.test)', '~/.docker/config.json', 'registry.example.test', true],
    ['DB_PASSWORD', '.env', 'db.example.test', false],
    // Only the hosts a service runs for its own API count.
    ['GITHUB_TOKEN', 'env', 'github.com', true],
    ['GITHUB_TOKEN', 'env', 'uploads.github.com', true],
    ['GITHUB_TOKEN', 'env', 'ghcr.io', true],
    ['GITHUB_TOKEN', 'env', 'npm.pkg.github.com', true],
    ['GITHUB_TOKEN', 'env', 'raw.githubusercontent.com', false],
    ['NETLIFY_AUTH_TOKEN', '.env', 'api.netlify.com', true],
    ['NETLIFY_AUTH_TOKEN', '.env', 'evil.netlify.com', false],
    ['HEROKU_API_KEY', '.env', 'api.heroku.com', true],
    ['VERCEL_TOKEN', '.env', 'api.vercel.com', true],
    ['CLOUDFLARE_API_TOKEN', '.env', 'api.cloudflare.com', true],
    ['DIGITALOCEAN_TOKEN', '.env', 'api.digitalocean.com', true],
    ['AZURE_STORAGE_KEY', '.env', 'blob.core.windows.net', false],
  ])('%s from %s to %s: %s', (name, source, host, own) => {
    expect(isOwnHost({ name, source }, host)).toBe(own);
  });
});

// Only the exact hosts of a service's own API are its own. Where any customer of a service can have
// an address (an S3 bucket, an API Gateway, a Supabase project, an Azure storage account, an Apps
// Script web app), or under the service's domain at all, the host is not the key owner's.
describe('a key sent to a host under its service’s domain that is not its API', () => {
  it.each([
    ['aws_secret_access_key', '~/.aws/credentials', 'abc.execute-api.us-east-1.amazonaws.com'],
    ['AWS_SECRET_ACCESS_KEY', '.env', 'evil-bucket.s3.amazonaws.com'],
    ['AWS_SECRET_ACCESS_KEY', '.env', 's3.us-east-1.amazonaws.com'],
    ['AWS_SECRET_ACCESS_KEY', '.env', 'abc.lambda-url.us-east-1.on.aws'],
    ['AZURE_STORAGE_KEY', '.env', 'evil.blob.core.windows.net'],
    ['AZURE_OPENAI_KEY', '.env', 'evil.openai.azure.com'],
    ['GOOGLE_API_KEY', '.env', 'script.google.com'],
    ['GOOGLE_API_KEY', '.env', 'storage.googleapis.com'],
    ['FIREBASE_TOKEN', '.env', 'evil.firebaseio.com'],
    ['SUPABASE_SERVICE_ROLE_KEY', '.env', 'attacker-project.supabase.co'],
    ['SLACK_BOT_TOKEN', '.env', 'hooks.slack.com'],
    ['SENTRY_AUTH_TOKEN', '.env', 'o1.ingest.sentry.io'],
    ['VERCEL_TOKEN', '.env', 'evil.vercel.app'],
    ['AWS_SECRET_ACCESS_KEY', '.env', 's3.amazonaws.com'],
    ['AZURE_STORAGE_KEY', '.env', 'blob.core.windows.net'],
    ['GITHUB_TOKEN', 'env', 'raw.githubusercontent.com'],
    ['GITHUB_TOKEN', 'env', 'gist.githubusercontent.com'],
    ['GITHUB_TOKEN', 'env', 'evil.github.io'],
    ['GITHUB_TOKEN', 'env', 'evil-8080.app.github.dev'],
    ['GITHUB_TOKEN', 'env', 'evil.github.com'],
    ['NETLIFY_AUTH_TOKEN', '.env', 'evil.netlify.com'],
    ['HEROKU_API_KEY', '.env', 'git.heroku.com'],
    ['HEROKU_API_KEY', '.env', 'evil.herokuapp.com'],
    ['CLOUDFLARE_API_TOKEN', '.env', 'acct.r2.cloudflarestorage.com'],
    ['DIGITALOCEAN_TOKEN', '.env', 'evil.digitaloceanspaces.com'],
    ['OPENAI_API_KEY', '.env', 'evil.openai.com'],
    ['STRIPE_SECRET_KEY', '.env', 'evil.stripe.com'],
    ['NPM_TOKEN', '.env', 'evil.npmjs.org'],
  ])('%s from %s to %s is not its own service', (name, source, host) => {
    expect(isOwnHost({ name, source }, host)).toBe(false);
  });
});

describe('a service that keeps what it is sent', () => {
  it.each([
    ['GITHUB_TOKEN', true],
    ['GITLAB_TOKEN', true],
    ['BITBUCKET_APP_PASSWORD', true],
    ['SLACK_BOT_TOKEN', true],
    ['DISCORD_BOT_TOKEN', true],
    ['NOTION_API_KEY', true],
    ['LINEAR_API_KEY', true],
    ['OPENAI_API_KEY', false],
    ['STRIPE_SECRET_KEY', false],
  ])('%s: %s', (name, keeps) => {
    expect(storesContent({ name, source: '.env' })).toBe(keeps);
  });
});
