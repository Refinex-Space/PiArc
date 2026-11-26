// Who is signed in (ADR-0083): a name for the account a stored sign-in belongs to, for the
// settings window. Only the name leaves this module; tokens stay in the credential store.
//
// Most flows keep a JWT (the access token, sometimes an id token) whose claims name the user;
// some keep the name itself. GitHub Copilot's tokens carry no identity: right after its sign-in
// the GitHub token asks GitHub's API for the login once.
import type { Credential } from '@earendil-works/pi-ai';

import { isObject } from '../runtime/items.js';

/** Longest name kept: a name, not a document. */
const MAX_NAME = 200;

/** Fields a flow may keep the name in, in order of preference. */
const NAME_FIELDS = ['email', 'login', 'username', 'userName', 'accountEmail'] as const;
/** Fields that may hold a JWT. */
const TOKEN_FIELDS = ['idToken', 'id_token', 'access'] as const;
/** OpenAI's claim object with the profile. */
const OPENAI_PROFILE = 'https://api.openai.com/profile';

function name(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text !== '' && text.length <= MAX_NAME && !/\s{2,}|[\p{Cc}]/u.test(text)
    ? text
    : undefined;
}

/** The claims of `token` when it is a JWT; nothing is verified, only read. */
export function jwtClaims(token: unknown): Record<string, unknown> | undefined {
  if (typeof token !== 'string') return undefined;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[1] === undefined) return undefined;
  try {
    const claims: unknown = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return isObject(claims) ? claims : undefined;
  } catch {
    return undefined;
  }
}

function claimedName(claims: Record<string, unknown>): string | undefined {
  const profile = claims[OPENAI_PROFILE];
  return (
    name(claims.email) ??
    (isObject(profile) ? name(profile.email) : undefined) ??
    name(claims.preferred_username) ??
    name(claims.upn) ??
    name(claims.name)
  );
}

/** The name of the account `credential` signs in, when it tells one. */
export function accountName(credential: Credential | undefined): string | undefined {
  if (credential?.type !== 'oauth') return undefined;
  const fields = credential as Record<string, unknown>;
  for (const field of NAME_FIELDS) {
    const found = name(fields[field]);
    if (found !== undefined) return found;
  }
  for (const field of TOKEN_FIELDS) {
    const claims = jwtClaims(fields[field]);
    const found = claims === undefined ? undefined : claimedName(claims);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * GitHub Copilot: the login of the GitHub user whose token `credential` keeps (its refresh
 * token is the GitHub OAuth token). `undefined` when GitHub does not answer in time.
 */
export async function githubLogin(
  credential: Credential | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<string | undefined> {
  if (credential?.type !== 'oauth' || typeof credential.refresh !== 'string') return undefined;
  const fields = credential as Record<string, unknown>;
  const enterprise =
    typeof fields.enterpriseUrl === 'string' && fields.enterpriseUrl !== ''
      ? fields.enterpriseUrl.replace(/^https?:\/\//u, '').replace(/\/.*$/u, '')
      : undefined;
  const api = enterprise === undefined ? 'https://api.github.com' : `https://${enterprise}/api/v3`;
  try {
    const response = await fetchImpl(`${api}/user`, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${credential.refresh}`,
        'User-Agent': 'PiArc',
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return undefined;
    const user: unknown = await response.json();
    return isObject(user) ? name(user.login) : undefined;
  } catch {
    return undefined;
  }
}
