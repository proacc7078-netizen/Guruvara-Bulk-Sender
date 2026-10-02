import fs from 'fs';
import { prisma } from '../config/db';

/**
 * Message permanent ("force") deletion.
 *
 * The normal DELETE /api/messages/:id path refuses any message still used by a
 * live (non-ARCHIVED) campaign. This service implements the *explicitly
 * confirmed* destructive alternative, reached only via confirm=true.
 *
 * Safety rules enforced here:
 *  - Runs as ONE prisma.$transaction for the database rows, so a failure
 *    leaves nothing partially deleted. The media file on disk is removed
 *    afterwards on a best-effort basis (matching the single-delete path).
 *  - Detaches live campaigns explicitly (Campaign.messageId = null) instead of
 *    relying on the schema SetNull, so the detach is auditable.
 *  - Execution snapshots (messageBody/messageName on CampaignExecution) are
 *    immutable strings and are never touched: history survives this delete.
 *  - Only ever removes THIS message plus its own Media row/file.
 */

export interface MessageForceDeleteCounts {
  messageId: string;
  detachedCampaigns: number;
  mediaId: string | null;
}

export interface MessageForceDeleteResult {
  deleted: true;
  counts: MessageForceDeleteCounts;
}

export class MessageNotFoundError extends Error {
  readonly code = 'NOT_FOUND';
  readonly statusCode = 404;

  constructor() {
    super('Message not found');
    this.name = 'MessageNotFoundError';
  }
}

/**
 * Permanently deletes a message, detaching it from live campaigns first.
 *
 * Order matters and is deliberate:
 *   1. Set Campaign.messageId = null for live (non-ARCHIVED) campaigns that
 *      still reference this message — those campaigns survive without content.
 *   2. Delete the Message row.
 *   3. Delete the Media row (if any) and remove the stored file afterwards.
 * Execution rows are untouched: their snapshots keep messageBody/messageName.
 */
export async function deleteMessageForce(messageId: string): Promise<MessageForceDeleteResult> {
  const existing = await prisma.message.findUnique({ where: { id: messageId }, select: { id: true } });
  if (!existing) {
    throw new MessageNotFoundError();
  }

  const media = await prisma.media.findFirst({ where: { messageId } });
  const detachedCount = await prisma.campaign.count({
    where: { messageId, status: { not: 'ARCHIVED' } },
  });

  await prisma.$transaction(async (tx) => {
    await tx.campaign.updateMany({
      where: { messageId, status: { not: 'ARCHIVED' } },
      data: { messageId: null },
    });
    await tx.message.delete({ where: { id: messageId } });
    if (media) {
      try {
        await tx.media.delete({ where: { id: media.id } });
      } catch {
        // media row already removed, continue
      }
    }
  });

  if (media) {
    try {
      if (fs.existsSync(media.storagePath)) fs.unlinkSync(media.storagePath);
    } catch {
      // file already gone, continue
    }
  }

  return {
    deleted: true,
    counts: { messageId, detachedCampaigns: detachedCount, mediaId: media ? media.id : null },
  };
}