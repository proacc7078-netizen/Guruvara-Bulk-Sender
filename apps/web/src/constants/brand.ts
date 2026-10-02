/**
 * Application identity (single source of truth).
 *
 * `BRAND_NAME` is the APPLICATION / company name and is intentionally distinct
 * from the signed-in user's personal profile name (which comes from
 * /api/auth/me). Do not merge the two.
 *
 * `BRAND_LOGO` is the supplied official asset, imported from source so the
 * bundler fingerprints and optimises it. It is used proportionally via
 * object-fit, never stretched.
 */
import brandLogo from '../assets/brand/amrita-varshini-cms-logo.jpg';

export const BRAND_NAME = 'Advaithamrutha Varshini';
export const BRAND_LOGO = brandLogo;
/** Short form used where horizontal space is tight (e.g. mobile drawer header). */
export const BRAND_SHORT = 'AV';

export const PRODUCT_DESCRIPTION =
  'Advaithamrutha Varshini — internal operations console for recipients, messages, campaigns and delivery history.';
