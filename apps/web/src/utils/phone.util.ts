/**
 * Normalizes a phone number to a canonical format.
 * - Removes all non-digit characters (spaces, hyphens, plus signs).
 * - If the number has exactly 10 digits, it prefixes it with '91' (assuming India).
 * - This provides a basic, consistent format for duplicate detection.
 */
export function normalizePhoneNumber(phone: string): string {
  if (!phone) return '';
  
  // Remove everything except digits
  let cleaned = phone.replace(/\D/g, '');
  
  // If exactly 10 digits, assume India and prepend 91
  if (cleaned.length === 10) {
    cleaned = '91' + cleaned;
  }
  
  return cleaned;
}
