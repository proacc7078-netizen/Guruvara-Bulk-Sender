import { Request, Response } from 'express';
import * as xlsx from 'xlsx';
import { prisma } from '../config/db';
import { normalizePhoneNumber } from '../utils/phone.util';
import { v4 as uuidv4 } from 'uuid';
import { Prisma } from '@prisma/client';
import { recordAuditSafe } from '../services/audit.service';

// In-memory store for import preview sessions
const importSessions = new Map<string, Prisma.RecipientCreateManyInput[]>();

export const previewImport = async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: { code: 'FILE_REQUIRED', message: 'An Excel or CSV file is required' } });
    }

    const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rows = xlsx.utils.sheet_to_json<any>(sheet);

    const validRows: Prisma.RecipientCreateManyInput[] = [];
    const invalidRows: Array<{
      rowNumber: number;
      data: any;
      reason: string;
    }> = [];
    const duplicateRows: Array<{
      rowNumber: number;
      data: any;
      reason: string;
    }> = [];

    // Pre-fetch all normalized phones to detect duplicates efficiently
    const existingRecipients = await prisma.recipient.findMany({
      select: { normalizedPhone: true }
    });
    const existingPhones = new Set(existingRecipients.map((r) => r.normalizedPhone));

    // Also track duplicates within the file itself
    const filePhones = new Set<string>();

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      // Map basic expected columns
      const rawName = row['Name'] || row['name'] || '';
      const rawPhone = row['WhatsApp Number'] || row['Phone'] || row['phone'] || '';
      
      const normalizedPhone = normalizePhoneNumber(String(rawPhone));
      
      // Extract consent information from the row
      const rawConsentStatus = row['Consent Status'] || row['consentStatus'] || row['Consent'] || '';
      const rawConsentTimestamp = row['Consent Timestamp'] || row['consentTimestamp'] || row['Consent Date'] || '';
      
      const consentStatus = rawConsentStatus ? String(rawConsentStatus).trim() : 'PENDING';
      const consentTimestamp = rawConsentTimestamp ? new Date(String(rawConsentTimestamp).trim()) : null;
      
      if (!rawName || !normalizedPhone) {
        invalidRows.push({ rowNumber: i + 2, data: row, reason: 'Missing name or valid phone number' });
        continue;
      }

      const recipientData: Prisma.RecipientCreateManyInput = {
        name: String(rawName).trim(),
        whatsappNumber: String(rawPhone).trim(),
        normalizedPhone,
        language: row['Language'] ? String(row['Language']).trim() : null,
        category: row['Category'] ? String(row['Category']).trim() : null,
        source: 'EXCEL',
        status: 'ACTIVE',
        consentStatus,
        consentTimestamp
      };

      if (existingPhones.has(normalizedPhone)) {
        duplicateRows.push({ rowNumber: i + 2, data: recipientData, reason: 'Recipient already exists in database' });
      } else if (filePhones.has(normalizedPhone)) {
        invalidRows.push({ rowNumber: i + 2, data: recipientData, reason: 'Duplicate phone number within the uploaded file' });
      } else {
        filePhones.add(normalizedPhone);
        validRows.push(recipientData);
      }
    }

    const sessionId = uuidv4();
    importSessions.set(sessionId, validRows);

    return res.json({
      success: true,
      data: {
        sessionId,
        summary: {
          totalRows: rows.length,
          validCount: validRows.length,
          duplicateCount: duplicateRows.length,
          invalidCount: invalidRows.length,
        },
        preview: {
          valid: validRows.slice(0, 10), // Send just a preview
          duplicates: duplicateRows.slice(0, 10),
          invalid: invalidRows.slice(0, 10)
        }
      }
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to process import file' } });
  }
};

export const confirmImport = async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId || !importSessions.has(sessionId)) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_SESSION', message: 'Invalid or expired import session' } });
    }

    const validRows = importSessions.get(sessionId)!;

    if (validRows.length === 0) {
      importSessions.delete(sessionId);
      return res.json({ success: true, data: { message: 'No rows to import', count: 0 } });
    }

    // Insert using transaction
    const result = await prisma.$transaction(async (tx) => {
      // Create recipients using individual creates to avoid type issues
      let count = 0;
      for (const row of validRows) {
        await tx.recipient.create({ data: row });
        count++;
      }
      return { count };
    });

    importSessions.delete(sessionId); // Clear session

    recordAuditSafe('IMPORT_CONFIRM', req, { sessionId, importedCount: result.count });

    return res.json({ success: true, data: { importedCount: result.count } });
  } catch (error) {
    return res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to confirm import' } });
  }
};
