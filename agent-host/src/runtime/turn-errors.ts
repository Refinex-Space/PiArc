// The kind of failure that ended a turn (`turn/completed`'s `errorKind` and `retryable`,
// ADR-0030). The client shows an error card per kind and offers a retry when `retryable`; it
// never reads the error text itself (architecture section 8.3).
//
// Providers report errors as text with the HTTP status and the provider's error type, which
// pi-ai keeps in the failed response's `errorMessage`; failures before a request (no
// credentials, no model) are errors thrown by Pi's `prompt`. Context overflow and transient
// failures use pi-ai's own classifiers, so PiArc agrees with Pi's retry loop: a turn that ends
// with a retryable error has already used Pi's automatic retries.
import { isContextOverflow, isRetryableAssistantError } from '@earendil-works/pi-ai';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { TurnErrorKind } from '@piarc/protocol';

export interface TurnError {
  readonly kind: TurnErrorKind;
  readonly retryable: boolean;
}

const AUTH =
  /(?<![a-z0-9])(?:401|403)(?![a-z0-9])|unauthori[sz]ed|authentication|invalid[ _-]?(?:x-)?api[ _-]?key|no api key|api key (?:is )?(?:missing|not (?:found|set))|credential|forbidden|permission[ _]denied/iu;
const QUOTA = /insufficient_quota|quota exceeded|out of budget|billing|usage limit/iu;
const RATE_LIMIT = /(?<![a-z0-9])429(?![a-z0-9])|rate.?limit|too many requests/iu;
const NETWORK =
  /fetch failed|network|econn(?:refused|reset|aborted)|enotfound|eai_again|getaddrinfo|socket hang up|timed? ?out|connection (?:refused|reset|lost|error|closed)|other side closed|upstream connect/iu;
const PROVIDER =
  /overloaded|(?<![a-z0-9])(?:500|502|503|504|520|524|529)(?![a-z0-9])|server.?error|internal.?error|unavailable|capacity|server_busy/iu;
const INVALID_REQUEST =
  /(?<![a-z0-9])(?:400|404|413|422)(?![a-z0-9])|invalid_request|bad request|unprocessable|not supported/iu;

/** The kind of a failed turn: `message` is the failed response when there is one. */
export function classifyTurnError(
  message: AssistantMessage | undefined,
  errorMessage: string,
): TurnError {
  if (message !== undefined && isContextOverflow(message)) {
    return { kind: 'contextOverflow', retryable: false };
  }
  if (AUTH.test(errorMessage)) {
    return { kind: 'auth', retryable: false };
  }
  if (QUOTA.test(errorMessage)) {
    return { kind: 'rateLimit', retryable: false };
  }
  if (RATE_LIMIT.test(errorMessage)) {
    return { kind: 'rateLimit', retryable: true };
  }
  if (NETWORK.test(errorMessage)) {
    return { kind: 'network', retryable: true };
  }
  if (PROVIDER.test(errorMessage)) {
    return { kind: 'provider', retryable: true };
  }
  if (INVALID_REQUEST.test(errorMessage)) {
    return { kind: 'invalidRequest', retryable: false };
  }
  if (message !== undefined && isRetryableAssistantError(message)) {
    return { kind: 'provider', retryable: true };
  }
  return { kind: 'internal', retryable: true };
}

/**
 * `StopFailure`'s error type (T41, Claude Code's matcher values) of a failed turn: the one place
 * that maps provider and Pi errors to `rate_limit`, `overloaded`, `authentication_failed`,
 * `billing_error`, `invalid_request`, `model_not_found`, `server_error`, `max_output_tokens`
 * and `unknown`.
 */
export function stopFailureType(
  message: AssistantMessage | undefined,
  errorMessage: string,
): string {
  if (message?.stopReason === 'length') return 'max_output_tokens';
  if (/overloaded|(?<![a-z0-9])529(?![a-z0-9])/iu.test(errorMessage)) return 'overloaded';
  if (QUOTA.test(errorMessage)) return 'billing_error';
  if (RATE_LIMIT.test(errorMessage)) return 'rate_limit';
  if (AUTH.test(errorMessage)) return 'authentication_failed';
  if (
    /model[_ ]not[_ ]found|unknown model|no such model|(?<![a-z0-9])404(?![a-z0-9])/iu.test(
      errorMessage,
    )
  ) {
    return 'model_not_found';
  }
  if (INVALID_REQUEST.test(errorMessage)) return 'invalid_request';
  if (
    /(?<![a-z0-9])5\d\d(?![a-z0-9])|server.?error|internal.?error|unavailable/iu.test(errorMessage)
  ) {
    return 'server_error';
  }
  return 'unknown';
}
