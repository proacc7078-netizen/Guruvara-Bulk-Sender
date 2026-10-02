/**
 * Credential/identifier rules shared by the authentication and user
 * management controllers, so both write paths accept exactly the same email
 * and password shapes.
 */

export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 128;
export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Lower-cased, trimmed email identifier, or null when it is not an email. */
export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const identifier = value.trim().toLowerCase();
  return EMAIL_PATTERN.test(identifier) ? identifier : null;
}

/** Password presence + length check (no complexity rules were defined before). */
export function isPassword(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= MIN_PASSWORD_LENGTH &&
    value.length <= MAX_PASSWORD_LENGTH
  );
}
