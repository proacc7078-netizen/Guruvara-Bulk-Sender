import {
  WhatsAppAdapter,
  ConnectionStatus,
  SendResult,
  MediaPayload,
  MessageStatus,
  WhatsAppVerificationResult,
} from './types';
import { WhatsAppProviderNotConfiguredError } from './errors';

export class UnconfiguredWhatsAppAdapter implements WhatsAppAdapter {
  async getStatus(): Promise<ConnectionStatus> {
    return 'DISCONNECTED';
  }

  async connect(): Promise<void> {
    throw new WhatsAppProviderNotConfiguredError(
      'WhatsApp provider is not configured. Cannot connect.'
    );
  }

  async disconnect(): Promise<void> {
    // Safely do nothing if we're not configured
  }

  async sendText(recipient: string, message: string): Promise<SendResult> {
    throw new WhatsAppProviderNotConfiguredError(
      'WhatsApp provider is not configured. Cannot send text.'
    );
  }

  async sendMedia(
    recipient: string,
    media: MediaPayload,
    caption?: string
  ): Promise<SendResult> {
    throw new WhatsAppProviderNotConfiguredError(
      'WhatsApp provider is not configured. Cannot send media.'
    );
  }

  async getMessageStatus(providerMessageId: string): Promise<MessageStatus> {
    throw new WhatsAppProviderNotConfiguredError(
      'WhatsApp provider is not configured. Cannot get message status.'
    );
  }

  async verifyConnection(): Promise<WhatsAppVerificationResult> {
    return {
      verified: false,
      reason: 'NOT_CONFIGURED',
      message: 'WhatsApp provider is not configured.',
    };
  }
}
