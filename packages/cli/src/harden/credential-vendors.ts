import { looksLikeToken } from '@stroq/core';

/**
 * Tokens of a known vendor's shape that core's list does not have. Core's list is what the secret
 * index uses to decide which values to guard; this one only decides whether a file holds
 * something that must not be copied or printed, so it can be longer and can lean toward yes.
 *
 * Every pattern is anchored at both ends, and none has a quantifier inside a group: a token is
 * checked against all of them, and a repository chooses the tokens.
 */
const MORE_VENDOR_TOKENS: readonly RegExp[] = [
  // Stripe secret and restricted keys (the publishable `pk_` ones are public).
  /^[sr]k_(?:live|test)_[A-Za-z0-9]{16,}$/,
  // GitLab personal access tokens.
  /^glpat-[A-Za-z0-9_-]{20,}$/,
  // SendGrid.
  /^SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}$/,
  // Hugging Face.
  /^hf_[A-Za-z0-9]{30,}$/,
  // PyPI upload tokens.
  /^pypi-[A-Za-z0-9_-]{50,}$/,
  // DigitalOcean.
  /^dop_v1_[a-f0-9]{64}$/,
  // Shopify access tokens.
  /^shp(?:at|ca|pa|ss)_[a-f0-9]{32}$/,
  // Google OAuth access tokens.
  /^ya29\.[A-Za-z0-9_-]{20,}$/,
  // Slack app-level tokens (core has the `xox` ones).
  /^xapp-[A-Za-z0-9-]{10,}$/,
  // Linear.
  /^lin_api_[A-Za-z0-9]{30,}$/,
  // Supabase personal access tokens.
  /^sbp_[a-f0-9]{40}$/,
];

/** Whether `token` has the shape of a vendor's token: core's list, and these. */
export const looksLikeVendorToken = (token: string): boolean =>
  looksLikeToken(token) || MORE_VENDOR_TOKENS.some((shape) => shape.test(token));
