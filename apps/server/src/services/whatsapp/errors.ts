export class WhatsAppProviderNotConfiguredError extends Error {
  constructor(message = 'WhatsApp provider is not configured.') {
    super(message);
    this.name = 'WhatsAppProviderNotConfiguredError';
  }
}

export class WhatsAppProviderUnavailableError extends Error {
  constructor(message = 'WhatsApp provider is unavailable.') {
    super(message);
    this.name = 'WhatsAppProviderUnavailableError';
  }
}

export class WhatsAppSendFailedError extends Error {
  constructor(message = 'Failed to send WhatsApp message.') {
    super(message);
    this.name = 'WhatsAppSendFailedError';
  }
}

export class WhatsAppConfigurationError extends Error {
  readonly code = 'WHATSAPP_CONFIGURATION_INVALID';
  constructor(message: string) {
    super(message);
    this.name = 'WhatsAppConfigurationError';
  }
}