import { prisma } from '../config/db';
import { WhatsAppAdapter, SendResult, MediaPayload } from './whatsapp/types';
import { whatsappProviderRegistry } from './whatsapp';
import { getWhatsAppMaxRetries } from './whatsapp/config';
import { classifyRetryability, calculateNextAttemptAt, shouldRetry } from './whatsapp/retry';
import { buildPublicMediaUrl } from './publicMedia.service';
import { resolveDeliveryStatus } from './whatsapp/whatsappWebhook.service';
import { isAlreadyDeliveredRecipient } from '../utils/campaignExecution.util';

/**
 * Phase 6.0D — infers the media MIME type from the snapshot's file extension.
 * The immutable execution snapshot stores only mediaPath (no mimeType), so the
 * extension is the immutable source available at delivery time. Falls back to
 * a safe generic type; Meta validates the real content on upload.
 */
const MEDIA_MIME_BY_EXTENSION: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.pdf': 'application/pdf',
};

function inferMediaMimeType(mediaPath: string): string {
  const dot = mediaPath.lastIndexOf('.');
  const ext = dot >= 0 ? mediaPath.slice(dot).toLowerCase() : '';
  return MEDIA_MIME_BY_EXTENSION[ext] || 'application/octet-stream';
}

/**
 * Provider-independent execution delivery service for sending ONE CampaignExecutionRecipient.
 * 
 * This service:
 * - loads the existing immutable execution snapshot
 * - uses the snapshot recipient phone number
 * - uses the snapshot message body
 * - calls WhatsAppAdapter.sendText()
 * - never reloads mutable Campaign/Message data for the actual send
 * - returns a sanitized provider-independent result
 * - handles retry scheduling for transient failures
 */
export class ExecutionDeliveryService {
  /**
   * Sends a single CampaignExecutionRecipient via the WhatsApp provider.
   * 
   * @param executionRecipientId The ID of the CampaignExecutionRecipient to send
   * @returns Promise containing the send result and updated recipient record
   */
  async sendExecutionRecipient(
    executionRecipientId: string
  ): Promise<{
    success: boolean;
    providerMessageId?: string;
    errorCode?: string;
    errorMessage?: string;
    executionRecipientId: string;
    retryScheduled?: boolean;
  }> {
    // Parse the executionRecipientId which should be in the format "executionId:recipientId"
    // This is how Prisma represents composite IDs in the API
    const [executionId, recipientId] = executionRecipientId.split(':');
    
    if (!executionId || !recipientId) {
      throw new Error(`Invalid execution recipient ID format: ${executionRecipientId}`);
    }

    // Load the execution recipient with its execution snapshot data
    const executionRecipient = await prisma.campaignExecutionRecipient.findUnique({
      where: {
        executionId_recipientId: {
          executionId,
          recipientId,
        },
      },
      include: {
        execution: true,
      },
    });

    if (!executionRecipient) {
      throw new Error(`Execution recipient not found: ${executionRecipientId}`);
    }

    // Prevent sending a recipient whose message was already handed to the
    // provider (SENT, or DELIVERED/READ advanced by a provider webhook).
    // This runs before the RUNNING/attemptCount write below, so a refused
    // duplicate never calls the provider, never increments attemptCount and
    // never touches providerMessageId or the sentAt/deliveredAt/readAt
    // evidence. FAILED is intentionally still sendable: the provider never
    // accepted that message, so retry/re-send is legitimate.
    if (isAlreadyDeliveredRecipient(executionRecipient.status)) {
      throw new Error(`Execution recipient already sent: ${executionRecipientId}`);
    }

    // Prevent sending if execution is cancelled
    if (executionRecipient.execution?.status === 'CANCELLED') {
      throw new Error(`Execution is cancelled: ${executionId}`);
    }

    // Phase 7.4 — no provider-specific branching here: the adapter comes from
    // the registry inside the try block below, which returns whatever
    // WHATSAPP_PROVIDER selects (the OpenWA adapter for WHATSAPP_PROVIDER=openwa,
    // the official Meta Cloud API adapter, or the safe unconfigured adapter).
    // This delivery path stays provider-independent.

    // Use the snapshot data from the execution
    const whatsappNumber = executionRecipient.whatsappNumber;
    const messageBody = executionRecipient.execution.messageBody;

    // Validate snapshot data
    if (!whatsappNumber || !whatsappNumber.trim()) {
      throw new Error('Invalid snapshot: missing whatsappNumber');
    }

    if (!messageBody || !messageBody.trim()) {
      throw new Error('Invalid snapshot: missing messageBody');
    }

    const maxRetries = getWhatsAppMaxRetries();

    // Update status to RUNNING to prevent duplicate sends, increment attemptCount.
    await prisma.campaignExecutionRecipient.update({
      where: {
        executionId_recipientId: {
          executionId,
          recipientId,
        },
      },
      data: {
        status: 'RUNNING',
        attemptCount: { increment: 1 },
      },
    });

    try {
      // Get the WhatsApp adapter via the provider registry (abstraction)
      const whatsAppAdapter: WhatsAppAdapter = whatsappProviderRegistry.getAdapter();

      // Phase 6.0D — media-aware delivery from the immutable snapshot.
      // mediaPath present → sendMedia(image) with the snapshot body as caption;
      // no media → the existing text-only path, byte-for-byte unchanged.
      // Both paths return the same SendResult, so retry classification and
      // status handling below are shared and untouched.
      const snapshotMediaPath = (executionRecipient.execution.mediaPath ?? '').trim();
      let sendResult: SendResult;
      if (snapshotMediaPath) {
        const media: MediaPayload = {
          path: snapshotMediaPath,
           url: executionRecipient.execution.mediaId ? buildPublicMediaUrl(executionRecipient.execution.mediaId) ?? undefined : undefined,

          mimeType: inferMediaMimeType(snapshotMediaPath),
        };
        sendResult = await whatsAppAdapter.sendMedia(
          whatsappNumber.trim(),
          media,
          messageBody.trim()
        );
      } else {
        // Send the text message using the adapter (provider-independent)
        sendResult = await whatsAppAdapter.sendText(
          whatsappNumber.trim(),
          messageBody.trim()
        );
      }

      if (sendResult.success) {
        // Success - mark as SENT.
        //
        // A provider webhook (DELIVERED/READ) can arrive before this write
        // completes. Writing SENT unconditionally would downgrade that evidence
        // and produce an inconsistent record (status SENT with readAt set).
        // The strongest known delivery evidence always wins, so the row is
        // re-read and settled inside one transaction before writing. sentAt and
        // providerMessageId are still recorded in either case.
        const updatedRecipient = await prisma.$transaction(async (tx) => {
          const fresh = await tx.campaignExecutionRecipient.findUnique({
            where: { executionId_recipientId: { executionId, recipientId } },
            select: { status: true, sentAt: true, deliveredAt: true, readAt: true },
          });
          const settled = resolveDeliveryStatus({
            status: fresh?.status ?? 'PENDING',
            sentAt: fresh?.sentAt ?? new Date(),
            deliveredAt: fresh?.deliveredAt ?? null,
            readAt: fresh?.readAt ?? null,
          });
          return tx.campaignExecutionRecipient.update({
            where: { executionId_recipientId: { executionId, recipientId } },
            data: {
              status: settled.status,
              providerMessageId: sendResult.providerMessageId,
              errorCode: null,
              errorMessage: null,
              nextAttemptAt: null,
              sentAt: fresh?.sentAt ?? new Date(),
            },
          });
        });

        return {
          success: true,
          providerMessageId: sendResult.providerMessageId,
          executionRecipientId: `${updatedRecipient.executionId}:${updatedRecipient.recipientId}`,
          retryScheduled: false,
        };
      }

      // Failure - classify retryability
      const classification = classifyRetryability(sendResult.errorCode, sendResult.metaError);
      const currentAttemptCount = executionRecipient.attemptCount + 1; // already incremented

      if (classification === 'retryable' && shouldRetry(currentAttemptCount, maxRetries)) {
        // Schedule retry
        const nextAttemptAt = calculateNextAttemptAt(currentAttemptCount);
        
        await prisma.campaignExecutionRecipient.update({
          where: {
            executionId_recipientId: {
              executionId,
              recipientId,
            },
          },
          data: {
            status: 'PENDING',
            errorCode: sendResult.errorCode,
            errorMessage: sendResult.errorMessage,
            nextAttemptAt,
          },
        });

        return {
          success: false,
          errorCode: sendResult.errorCode,
          errorMessage: sendResult.errorMessage,
          executionRecipientId,
          retryScheduled: true,
        };
      }

      // Non-retryable or max retries exceeded - mark as FAILED
      await prisma.campaignExecutionRecipient.update({
        where: {
          executionId_recipientId: {
            executionId,
            recipientId,
          },
        },
        data: {
          status: 'FAILED',
          errorCode: sendResult.errorCode,
          errorMessage: sendResult.errorMessage,
          nextAttemptAt: null,
        },
      });

      return {
        success: false,
        errorCode: sendResult.errorCode,
        errorMessage: sendResult.errorMessage,
        executionRecipientId,
        retryScheduled: false,
      };
    } catch (error) {
      // Handle unexpected errors - classify as retryable (network/unexpected)
      const currentAttemptCount = executionRecipient.attemptCount + 1; // already incremented
      const classification = classifyRetryability('WHATSAPP_PROVIDER_UNAVAILABLE');
      
      if (classification === 'retryable' && shouldRetry(currentAttemptCount, maxRetries)) {
        // Schedule retry for unexpected errors
        const nextAttemptAt = calculateNextAttemptAt(currentAttemptCount);
        
        await prisma.campaignExecutionRecipient.update({
          where: {
            executionId_recipientId: {
              executionId,
              recipientId,
            },
          },
          data: {
            status: 'PENDING',
            errorCode: 'WHATSAPP_PROVIDER_UNAVAILABLE',
            errorMessage: error instanceof Error ? error.message : 'Unknown error occurred',
            nextAttemptAt,
          },
        });

        return {
          success: false,
          errorCode: 'WHATSAPP_PROVIDER_UNAVAILABLE',
          errorMessage: error instanceof Error ? error.message : 'Unknown error occurred',
          executionRecipientId,
          retryScheduled: true,
        };
      }

      // Non-retryable or max retries exceeded
      await prisma.campaignExecutionRecipient.update({
        where: {
          executionId_recipientId: {
            executionId,
            recipientId,
          },
        },
        data: {
          status: 'FAILED',
          errorCode: 'WHATSAPP_PROVIDER_UNAVAILABLE',
          errorMessage: error instanceof Error ? error.message : 'Unknown error occurred',
          nextAttemptAt: null,
        },
      });

      throw error;
    }
  }
}