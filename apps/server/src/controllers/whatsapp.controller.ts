import { Request, Response, RequestHandler } from 'express';
import { createWhatsAppAdapterForConfig } from '../services/whatsapp/whatsappProvider';
import {
  isOfficialProviderConfigured,
  resolveWhatsAppConfigState,
  summarizeOpenWAConfig,
  type WhatsAppOpenWAConfig,
  type WhatsAppOfficialConfig,
} from '../services/whatsapp/config';

/**
 * Phase 5.3 — POST /api/whatsapp/send-test (authenticated).
 *
 * TEST NUMBER ONLY. Single text send via OfficialWhatsAppAdapter.
 * Not connected to Campaigns or Messages. Sanitized result only.
 */
export const sendTest: RequestHandler = async (req, res, next) => {
  try {
    const { rawProvider, config, error } = resolveWhatsAppConfigState();

    if (!config || error || !isOfficialProviderConfigured(config)) {
      if (rawProvider === 'none' || (!config && rawProvider === 'none')) {
        res.status(409).json({
          success: false,
          errorCode: 'WHATSAPP_PROVIDER_NOT_CONFIGURED',
          errorMessage: 'WhatsApp provider is not configured.',
        });
        return;
      }
      res.status(409).json({
        success: false,
        errorCode: 'WHATSAPP_CONFIGURATION_INVALID',
        errorMessage: 'Official WhatsApp provider configuration is incomplete.',
      });
      return;
    }

    const to = typeof req.body?.to === 'string' ? req.body.to.trim() : '';
    const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
    if (!to) {
      res.status(400).json({
        success: false,
        errorCode: 'WHATSAPP_CONFIGURATION_INVALID',
        errorMessage: 'Field "to" (recipient phone number) is required.',
      });
      return;
    }
    if (!message) {
      res.status(400).json({
        success: false,
        errorCode: 'WHATSAPP_CONFIGURATION_INVALID',
        errorMessage: 'Field "message" (text body) is required.',
      });
      return;
    }

    const adapter = createWhatsAppAdapterForConfig(config);
    const result = await adapter.sendText(to, message);
    if (result.success) {
      res.json(result);
      return;
    }
    const status =
      result.errorCode === 'WHATSAPP_CONFIGURATION_INVALID'
        ? 400
        : result.errorCode === 'WHATSAPP_PROVIDER_UNAVAILABLE'
          ? 502
          : 500;
    res.status(status).json(result);
  } catch (error) {
    next(error);
  }
};

/**
 * Phase 5.2B — GET /api/whatsapp/status (authenticated).
 * Phase 7.1 — extended with the OpenWA (unofficial, opt-in) provider.
 *
 * CONNECTION VERIFICATION ONLY. Never sends a message.
 *
 * Response distinguishes:
 * - provider not configured  -> { configured:false, provider:'none', status, verification:{verified:false,reason:'NOT_CONFIGURED'} }
 * - configured but verification failed (invalid config OR provider auth/network/API failure)
 *                             -> { configured:true, provider:'official'|'openwa', status, config, verification:{verified:false,...} }
 * - configured and API access verified
 *                             -> { configured:true, provider:'official'|'openwa', status:'CONNECTED', config, verification:{verified:true,reason:'VERIFIED'} }
 *
 * No credentials (API keys, access tokens, Authorization headers) are logged
 * or returned. The OpenWA branch reports a masked session id only.
 */
export const getStatus: RequestHandler = async (req, res, next) => {
  try {
    const { rawProvider, config, error } = resolveWhatsAppConfigState();

    // Phase 7.1 — OpenWA (unofficial, opt-in). Reports a safe configuration and
    // connection summary only; it never sends a message and never contacts the
    // OpenWA instance with missing configuration.
    if (rawProvider === 'openwa') {
      if (!config || error || config.provider !== 'openwa') {
        res.json({
          configured: true,
          provider: 'openwa',
          status: 'DISCONNECTED',
          verification: {
            verified: false,
            reason: 'CONFIG_INVALID',
            message: 'OpenWA provider configuration is incomplete.',
          },
        });
        return;
      }

      const openwaConfig: WhatsAppOpenWAConfig = config;
      const adapter = createWhatsAppAdapterForConfig(config);
      const configSummary = adapter.getConfigSummary?.() ?? summarizeOpenWAConfig(openwaConfig);
      const verification = adapter.verifyConnection
        ? await adapter.verifyConnection()
        : {
            verified: false as const,
            reason: 'API_ERROR' as const,
            message: 'Verification is not supported by this provider.',
          };
      const status = verification.verified ? 'CONNECTED' : 'DISCONNECTED';
      res.json({ configured: true, provider: 'openwa', status, config: configSummary, verification });
      return;
    }

    if (!config || error) {
      if (rawProvider === 'none') {
        const adapter = createWhatsAppAdapterForConfig({ provider: 'none' });
        const status = await adapter.getStatus();
        const verification = adapter.verifyConnection
          ? await adapter.verifyConnection()
          : { verified: false as const, reason: 'NOT_CONFIGURED' as const, message: 'WhatsApp provider is not configured.' };
        res.json({ configured: false, provider: 'none', status, verification });
        return;
      }
      // WHATSAPP_PROVIDER=official but required env vars are missing/invalid.
      res.json({
        configured: true,
        provider: 'official',
        status: 'DISCONNECTED',
        verification: {
          verified: false,
          reason: 'CONFIG_INVALID',
          message: 'Official WhatsApp provider configuration is incomplete.',
        },
      });
      return;
    }

    const isOfficial = isOfficialProviderConfigured(config);
    if (!isOfficial) {
      const adapter = createWhatsAppAdapterForConfig(config);
      const status = await adapter.getStatus();
      const verification = adapter.verifyConnection
        ? await adapter.verifyConnection()
        : { verified: false as const, reason: 'NOT_CONFIGURED' as const, message: 'WhatsApp provider is not configured.' };
      res.json({ configured: false, provider: 'none', status, verification });
      return;
    }

    // Official provider configured: safe diagnostics + live non-message verification.
    const officialConfig = config as WhatsAppOfficialConfig;
    const adapter = createWhatsAppAdapterForConfig(config);
    const configSummary = adapter.getConfigSummary?.() ?? {
      provider: 'official' as const,
      phoneNumberId: officialConfig.phoneNumberId,
      apiVersion: officialConfig.apiVersion,
      apiBaseUrl: officialConfig.apiBaseUrl,
    };
    const verification = adapter.verifyConnection
      ? await adapter.verifyConnection()
      : { verified: false as const, reason: 'API_ERROR' as const, message: 'Verification is not supported by this provider.' };
    const status = verification.verified ? 'CONNECTED' : 'DISCONNECTED';
    res.json({ configured: true, provider: 'official', status, config: configSummary, verification });
  } catch (error) {
    next(error);
  }
};