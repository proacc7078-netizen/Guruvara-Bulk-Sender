import { WhatsAppErrorCode } from './types';

/**
 * Retry classification for WhatsApp delivery failures.
 * 
 * Retryable failures are transient issues that may succeed on retry:
 * - Network failures, timeouts
 * - Temporary provider/API failures (5xx)
 * 
 * Non-retryable failures are permanent issues that won't succeed on retry:
 * - Invalid credentials/authentication (401/403)
 * - Invalid recipient
 * - Malformed request (400)
 * - Configuration errors
 */
export type RetryClassification = 'retryable' | 'non-retryable' | 'unknown';

/**
 * Classifies a WhatsApp send failure as retryable or non-retryable based on the error code.
 * 
 * @param errorCode - The error code from the SendResult
 * @param metaError - Optional Meta error details with HTTP status
 * @returns Retry classification
 */
export function classifyRetryability(
  errorCode: string | undefined,
  metaError?: { httpStatus?: number; code?: number | string; type?: string }
): RetryClassification {
  if (!errorCode) {
    return 'unknown';
  }

  switch (errorCode) {
    case 'WHATSAPP_PROVIDER_UNAVAILABLE': {
      // Network errors, timeouts, and 5xx are retryable
      // But 401/403 auth failures are non-retryable
      const httpStatus = metaError?.httpStatus;
      if (httpStatus === 401 || httpStatus === 403) {
        return 'non-retryable';
      }
      // Network error, timeout, or 5xx
      return 'retryable';
    }

    case 'WHATSAPP_SEND_FAILED': {
      // Check HTTP status for 5xx vs 4xx
      const httpStatus = metaError?.httpStatus;
      if (httpStatus && httpStatus >= 500 && httpStatus < 600) {
        return 'retryable';
      }
      // 4xx errors (except 401/403 which would be UNAVAILABLE) are non-retryable
      return 'non-retryable';
    }

    case 'WHATSAPP_CONFIGURATION_INVALID':
      // Invalid recipient, malformed request, missing config - never retry
      return 'non-retryable';

    case 'WHATSAPP_PROVIDER_NOT_CONFIGURED':
      // Provider not configured - non-retryable
      return 'non-retryable';

    default:
      return 'unknown';
  }
}

/**
 * Determines if a recipient should be retried based on attempt count and max retries.
 * 
 * @param attemptCount - Current attempt count
 * @param maxRetries - Maximum allowed retries
 * @returns true if retry should be attempted
 */
export function shouldRetry(attemptCount: number, maxRetries: number): boolean {
  return attemptCount < maxRetries;
}

/**
 * Calculates the next retry time using exponential backoff with jitter.
 * 
 * Base delay: 30 seconds
 * Multiplier: 2^attemptCount (exponential)
 * Max delay: 1 hour
 * Jitter: ±25%
 * 
 * @param attemptCount - Current attempt count (0-based, so first retry is attemptCount=1)
 * @returns Date for next attempt
 */
export function calculateNextAttemptAt(attemptCount: number): Date {
  const baseDelayMs = 30_000; // 30 seconds
  const maxDelayMs = 60 * 60 * 1000; // 1 hour
  
  // Exponential backoff: 30s, 60s, 120s, 240s, 480s, 960s, 1920s (capped at 1hr)
  const exponentialDelay = Math.min(baseDelayMs * Math.pow(2, attemptCount - 1), maxDelayMs);
  
  // Add ±25% jitter
  const jitter = exponentialDelay * 0.25 * (Math.random() * 2 - 1);
  const delay = Math.max(baseDelayMs, exponentialDelay + jitter);
  
  return new Date(Date.now() + delay);
}