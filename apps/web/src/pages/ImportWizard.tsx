import { useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import axios from 'axios';
import { Sidebar } from '../components/Sidebar';
import { Upload, AlertCircle, FileSpreadsheet, Trash2, ArrowLeft, ArrowRight, Check } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import {
  applyDuplicateDetection,
  clearDuplicateDetection,
  collectUniqueNormalizedPhones,
  describeDuplicateStatus,
  getDuplicateSummary,
  getObviousMatch,
  MAPPING_FIELDS,
  validateAndNormalizeRows,
} from '../utils/importMapping.util';
import type { ColumnMapping, ImportRow, ImportRowStatus, ParsedPreview } from '../utils/importMapping.util';
import {
  buildImportSelection,
  canChangeImportDecision,
  deselectAllRows,
  getImportDecisionDetails,
  getImportPreviewSummary,
  getRowDecision,
  reconcileImportSelection,
  selectAllImportableRows,
  setImportDecision,
} from '../utils/importSelection.util';
import type { ImportDecision, ImportSelection } from '../utils/importSelection.util';
import { buildImportPayload } from '../utils/importApi.util';
import type { ImportResult, ImportRowResult } from '../utils/importApi.util';


const SUPPORTED_EXTENSIONS = ['.csv', '.xlsx', '.xls'];
const PREVIEW_ROW_COUNT = 5;

function getExtension(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot >= 0 ? fileName.slice(dot).toLowerCase() : '';
}

function getStatusBadge(status: boolean): string {
  return status
    ? 'inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200'
    : 'inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200';
}

// Step 12D: badge styling / labels per overall row status
function getRowStatusBadge(status: ImportRowStatus): string {
  switch (status) {
    case 'invalid':
      return 'inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200';
    case 'existing-duplicate':
      return 'inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200';
    case 'within-file-duplicate':
      return 'inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200';
    case 'existing-and-within-file-duplicate':
      return 'inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200';
    default:
      return 'inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200';
  }
}

function getRowStatusLabel(status: ImportRowStatus): string {
  switch (status) {
    case 'invalid':
      return 'Invalid row';
    case 'existing-duplicate':
      return 'Existing duplicate';
    case 'within-file-duplicate':
      return 'Within-file duplicate';
    case 'existing-and-within-file-duplicate':
      return 'Existing + within-file duplicate';
    default:
      return 'No duplicate';
  }
}

// Step 12E: import preview decision styling (segmented IMPORT / SKIP control)
const DECISION_BUTTON_IMPORT_ON =
  'inline-flex items-center px-2 py-1 text-xs font-medium border border-green-600 bg-green-600 text-white hover:bg-green-700 rounded-l-md';
const DECISION_BUTTON_IMPORT_OFF =
  'inline-flex items-center px-2 py-1 text-xs font-medium border border-gray-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-zinc-700 rounded-l-md';
const DECISION_BUTTON_SKIP_ON =
  'inline-flex items-center px-2 py-1 text-xs font-medium border border-gray-500 bg-gray-600 text-white hover:bg-gray-700 rounded-r-md';
const DECISION_BUTTON_SKIP_OFF =
  'inline-flex items-center px-2 py-1 text-xs font-medium border border-gray-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-zinc-700 rounded-r-md';

function getDecisionBadgeClass(decision: ImportDecision): string {
  return decision === 'IMPORT'
    ? 'inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200'
    : 'inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-gray-200 text-gray-700 dark:bg-zinc-700 dark:text-gray-200';
}

function getDecisionButtonClass(decision: ImportDecision, importButton: boolean): string {
  if (importButton) {
    return decision === 'IMPORT' ? DECISION_BUTTON_IMPORT_ON : DECISION_BUTTON_IMPORT_OFF;
  }
  return decision === 'SKIP' ? DECISION_BUTTON_SKIP_ON : DECISION_BUTTON_SKIP_OFF;
}

// Step 12F: badge styling per final import row outcome
function getImportResultBadgeClass(status: ImportRowResult['status']): string {
  switch (status) {
    case 'CREATED':
      return 'inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200';
    case 'SKIPPED':
      return 'inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200';
    default:
      return 'inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200';
  }
}

export default function ImportWizard() {
  const navigate = useNavigate();
  const [file, setFile] = useState<File | null>(null);
  const [parsing, setParsing] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<ParsedPreview | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [mapping, setMapping] = useState<ColumnMapping>({
    name: null,
    whatsappNumber: null,
    language: null,
    category: null,
    consentStatus: null,
    consentTimestamp: null,
    notes: null,
    source: null,
  });
  const [step, setStep] = useState<'upload' | 'mapping' | 'validate' | 'duplicates' | 'preview' | 'confirmation' | 'result'>('upload');
  const [mappingError, setMappingError] = useState('');
  const [importRows, setImportRows] = useState<ImportRow[]>([]);
  const [importSelection, setImportSelection] = useState<ImportSelection>({});
  const [duplicateChecking, setDuplicateChecking] = useState(false);
  const [duplicateError, setDuplicateError] = useState('');
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState('');
  const [importResult, setImportResult] = useState<ImportResult | null>(null);

  const resetSelection = () => {
    setFile(null);
    setPreview(null);
    setError('');
    setMapping({
      name: null,
      whatsappNumber: null,
      language: null,
      category: null,
      consentStatus: null,
      consentTimestamp: null,
      notes: null,
      source: null,
    });
    setMappingError('');
    setStep('upload');
    setImportRows([]);
    setImportSelection({});
    setDuplicateChecking(false);
    setDuplicateError('');
    setImporting(false);
    setImportError('');
    setImportResult(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const parseFile = async (selectedFile: File) => {
    setParsing(true);
    setError('');
    setPreview(null);

    try {
      const extension = getExtension(selectedFile.name);
      if (!SUPPORTED_EXTENSIONS.includes(extension)) {
        setError(`Unsupported file type. Please select a ${SUPPORTED_EXTENSIONS.join(', ')} file.`);
        return;
      }

      let buffer: ArrayBuffer;
      try {
        buffer = await selectedFile.arrayBuffer();
      } catch {
        setError('The file could not be read. Please try selecting it again.');
        return;
      }

      if (!buffer || buffer.byteLength === 0) {
        setError('The selected file is empty. Please select a file containing data rows.');
        return;
      }

      let workbook: XLSX.WorkBook;
      try {
        workbook = XLSX.read(buffer, { type: 'array' });
      } catch {
        setError('The spreadsheet is malformed and could not be parsed. Please check the file and try again.');
        return;
      }

      if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
        setError('No worksheets were found in the file. Please select a file containing data rows.');
        return;
      }

      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      let rows: Array<Record<string, unknown>>;
      try {
        rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '' });
      } catch {
        setError('The CSV could not be parsed. Please check the file format and try again.');
        return;
      }

      if (!rows || rows.length === 0) {
        setError('No rows were found in the file. Please select a file containing data rows.');
        return;
      }

      const headers = Array.from(
        new Set(rows.flatMap((row) => Object.keys(row)))
      );

      setPreview({
        fileName: selectedFile.name,
        headers,
        rows: rows.slice(0, PREVIEW_ROW_COUNT),
        allRows: rows,
        totalRows: rows.length
      });
    } finally {
      setParsing(false);
    }
  };

  const handleFileSelect = (selectedFile: File | undefined | null) => {
    if (!selectedFile) return;
    setFile(selectedFile);
    setMapping({
      name: null,
      whatsappNumber: null,
      language: null,
      category: null,
      consentStatus: null,
      consentTimestamp: null,
      notes: null,
      source: null,
    });
    setMappingError('');
    setStep('upload');
    setImportRows([]);
    setImportSelection({});
    setDuplicateChecking(false);
    setDuplicateError('');
    void parseFile(selectedFile);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    handleFileSelect(e.target.files?.[0]);
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    handleFileSelect(e.dataTransfer.files?.[0]);
  };

  const updateMapping = (fieldKey: keyof ColumnMapping, headerValue: string | null) => {
    setMapping((prev) => {
      const next = { ...prev, [fieldKey]: headerValue };
      for (const field of MAPPING_FIELDS) {
        if (field.key !== fieldKey && next[field.key] === headerValue) {
          next[field.key] = null;
        }
      }
      return next;
    });
    setMappingError('');
    // Step 12D: changing the mapping invalidates the duplicate results, so they
    // are discarded here and recalculated from the newly normalized phones.
    setImportRows((prev) => clearDuplicateDetection(prev));
    setDuplicateError('');
    // Step 12E: the preview decisions belong to the previous classification
    setImportSelection({});
  };

  const isColumnUsed = (header: string, excludeField?: keyof ColumnMapping): boolean => {
    if (!header) return false;
    return MAPPING_FIELDS.some((field) => {
      if (field.key === excludeField) return false;
      return mapping[field.key] === header;
    });
  };

  const availableHeaders = preview?.headers ?? [];

  const canContinueMapping = Boolean(mapping.name && mapping.whatsappNumber);

  const handleContinueMapping = () => {
    if (!canContinueMapping) {
      setMappingError('Please map both Name and WhatsApp Number before continuing.');
      return;
    }
    setMappingError('');
    const rows = validateAndNormalizeRows(preview!, mapping);
    setImportRows(rows);
    // Step 12E: fresh decisions for the freshly classified rows
    setImportSelection(buildImportSelection(rows));
    setStep('validate');
  };

  const handleBackToMapping = () => {
    setStep('mapping');
  };

  /**
   * Step 12D: performs the duplicate detection.
   * One single read-only request is sent with the unique normalized phones of
   * the valid rows; within-file duplicates are computed client-side.
   */
  const handleRunDuplicateCheck = async () => {
    setDuplicateError('');
    setDuplicateChecking(true);

    const existingPhones: string[] = [];

    try {
      const uniquePhones = collectUniqueNormalizedPhones(importRows);

      if (uniquePhones.length > 0) {
        const response = await axios.post('/api/recipients/import-duplicates', {
          normalizedPhones: uniquePhones
        });

        if (!response.data?.success) {
          throw new Error('Duplicate check failed');
        }

        const duplicates = response.data.data?.duplicates ?? [];
        for (const duplicate of duplicates) {
          if (duplicate?.normalizedPhone) {
            existingPhones.push(duplicate.normalizedPhone);
          }
        }
      }
    } catch (err: any) {
      setDuplicateError(
        err.response?.data?.error?.message ||
          'Could not check for existing recipients. Please try again.'
      );
      setDuplicateChecking(false);
      return;
    }

    const detectedRows = applyDuplicateDetection(importRows, existingPhones);
    setImportRows(detectedRows);
    // Step 12E: decisions are recalculated; a manual SKIP is only kept for rows
    // that are still valid, unique and therefore still importable.
    setImportSelection((prev) => reconcileImportSelection(detectedRows, prev));
    setDuplicateChecking(false);
    setStep('duplicates');
  };

  const handleBackToValidation = () => {
    setStep('validate');
  };

  /** Step 12E: opens the final preview from the rows already in memory. */
  const handleContinueToPreview = () => {
    setImportSelection((prev) => reconcileImportSelection(importRows, prev));
    setStep('preview');
  };

  const handleBackToDuplicates = () => {
    setStep('duplicates');
  };

  const handleBackToPreview = () => {
    setStep('preview');
  };

  /** Only valid unique rows can be toggled; every locked row stays SKIP. */
  const handleDecisionChange = (rowNumber: number, decision: ImportDecision) => {
    const row = importRows.find((candidate) => candidate.rowNumber === rowNumber);
    if (!row) return;
    setImportSelection((prev) => setImportDecision(prev, row, decision));
  };

  const handleSelectAllImportable = () => {
    setImportSelection(selectAllImportableRows(importRows));
  };

  const handleDeselectAll = () => {
    setImportSelection(deselectAllRows(importRows));
  };

  /**
   * Step 12E ends here: this only navigates to the confirmation state. It makes
   * no request and writes nothing — the actual import is the explicit Step 12F
   * `handleConfirmImport` action the user triggers from that screen.
   */
  const handleContinueToConfirmation = () => {
    setStep('confirmation');
  };

  /**
   * Step 12F: submits ONLY the rows the user marked IMPORT in Step 12E to the
   * authenticated import endpoint. Rows marked SKIP — and therefore every
   * invalid, existing-duplicate and within-file-duplicate row — are never sent.
   * The `importing` guard plus the disabled button prevent double submission.
   */
  const handleConfirmImport = async () => {
    if (importing) return;
    const payload = buildImportPayload(importRows, importSelection);
    if (payload.rows.length === 0) {
      setImportError('No rows are selected for import. Mark at least one row as IMPORT before confirming.');
      return;
    }
    setImportError('');
    setImporting(true);
    try {
      const response = await axios.post('/api/recipients/import', payload);
      if (!response.data?.success) {
        throw new Error('Import failed');
      }
      setImportResult(response.data.data as ImportResult);
      setStep('result');
    } catch {
      // No stack trace, Prisma error or server internals is surfaced to the user.
      setImportError('Could not import the selected recipients. Nothing was lost — you can try confirming again.');
    } finally {
      setImporting(false);
    }
  };

  /**
   * Step 12F: leaves the wizard for the Recipients list. The list fetches its
   * recipients on mount, so the newly created rows appear without restarting
   * the wizard or re-submitting anything.
   */
  const handleBackToRecipients = () => {
    navigate('/recipients');
  };

  const validRows = importRows.filter((r) => r.isValid);
  const invalidRows = importRows.filter((r) => !r.isValid);
  const duplicateSummary = getDuplicateSummary(importRows);
  const previewSummary = getImportPreviewSummary(importRows, importSelection);

  return (
    <div className="flex min-h-screen bg-gray-50 dark:bg-zinc-900">
      <Sidebar />
      <main className="min-w-0 flex-1">
        <div className="py-6 max-w-4xl mx-auto px-4 sm:px-6 md:px-8">
          <div className="flex justify-between items-center mb-6">
            <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">Import Recipients</h1>
            <Link to="/recipients" className="px-4 py-2 border border-gray-300 text-gray-700 dark:text-gray-300 dark:border-zinc-600 rounded-md text-sm font-medium hover:bg-gray-50 dark:hover:bg-zinc-700">
              Back to Recipients
            </Link>
          </div>

          {error && (
            <div className="mb-4 p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-md flex items-start">
              <AlertCircle className="h-5 w-5 text-red-500 mr-2 flex-shrink-0 mt-0.5" />
              <span className="text-sm text-red-700 dark:text-red-400">{error}</span>
            </div>
          )}

          <div className="bg-white dark:bg-zinc-800 shadow sm:rounded-lg p-6 border border-gray-200 dark:border-zinc-700">
            <h3 className="text-lg leading-6 font-medium text-gray-900 dark:text-white">Upload Excel or CSV</h3>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              Supported formats: <span className="font-medium">.csv, .xlsx, .xls</span>
            </p>

            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
              className={`mt-4 border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors ${
                dragOver
                  ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
                  : 'border-gray-300 dark:border-zinc-600 hover:border-blue-400 dark:hover:border-blue-500'
              }`}
            >
              <Upload className="mx-auto h-10 w-10 text-gray-400 mb-2" />
              <p className="text-sm text-gray-600 dark:text-gray-300">
                Drag and drop a file here, or <span className="text-blue-600 dark:text-blue-400 font-medium">click to browse</span>
              </p>
              <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">One file at a time — .csv, .xlsx, .xls</p>
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,.xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/csv"
                onChange={handleFileChange}
                className="hidden"
              />
            </div>

            {file && (
              <div className="mt-4 flex items-center justify-between px-4 py-3 bg-gray-50 dark:bg-zinc-900 rounded-md">
                <div className="flex items-center min-w-0">
                  <FileSpreadsheet className="h-5 w-5 text-gray-400 mr-2 flex-shrink-0" />
                  <span className="text-sm text-gray-900 dark:text-white truncate">{file.name}</span>
                </div>
                <button
                  onClick={resetSelection}
                  className="inline-flex items-center text-sm text-red-600 hover:text-red-800 dark:text-red-400 dark:hover:text-red-300 ml-4 flex-shrink-0"
                >
                  <Trash2 className="h-4 w-4 mr-1" />
                  Remove
                </button>
              </div>
            )}

            {parsing && (
              <div className="mt-4 p-4 text-center text-sm text-gray-500 dark:text-gray-400">
                Parsing file...
              </div>
            )}
          </div>

          {preview && !parsing && step === 'upload' && (
            <div className="mt-6 bg-white dark:bg-zinc-800 shadow sm:rounded-lg p-6 border border-gray-200 dark:border-zinc-700">
              <h3 className="text-lg leading-6 font-medium text-gray-900 dark:text-white">Raw Parsing Preview</h3>
              <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                File: <span className="font-medium text-gray-900 dark:text-white">{preview.fileName}</span>
                {' '}— Total parsed rows: <span className="font-medium text-gray-900 dark:text-white">{preview.totalRows}</span>
              </p>

              <div className="mt-4">
                <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Detected Column Headers</h4>
                {preview.headers.length === 0 ? (
                  <p className="text-sm text-gray-500 dark:text-gray-400">No headers detected.</p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {preview.headers.map((header) => (
                      <span key={header} className="px-2 py-1 text-xs font-medium rounded-full bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200">
                        {header || '(empty)'}
                      </span>
                    ))}
                  </div>
                )}
              </div>

              <div className="mt-4">
                <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  First {preview.rows.length} Data Row{preview.rows.length === 1 ? '' : 's'}
                </h4>
                <div className="overflow-x-auto border border-gray-200 dark:border-zinc-700 rounded-md">
                  <table className="min-w-full divide-y divide-gray-200 dark:divide-zinc-700">
                    <thead className="bg-gray-50 dark:bg-zinc-900">
                      <tr>
                        {preview.headers.map((header) => (
                          <th key={header} scope="col" className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                            {header || '(empty)'}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="bg-white dark:bg-zinc-800 divide-y divide-gray-200 dark:divide-zinc-700">
                      {preview.rows.map((row, i) => (
                        <tr key={i}>
                          {preview.headers.map((header) => (
                            <td key={header} className="px-4 py-2 whitespace-nowrap text-sm text-gray-500 dark:text-gray-300">
                              {String(row[header] ?? '')}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <p className="mt-4 text-xs text-gray-400 dark:text-gray-500">
                This is a raw parsing preview only. Nothing has been imported into the database.
              </p>

              <div className="mt-6 flex justify-end">
                <button
                  onClick={() => setStep('mapping')}
                  className="inline-flex items-center px-4 py-2 border border-gray-300 dark:border-zinc-600 shadow-sm text-sm font-medium rounded-md text-gray-700 dark:text-gray-300 bg-white dark:bg-zinc-800 hover:bg-gray-50 dark:hover:bg-zinc-700"
                >
                  Continue to Column Mapping
                </button>
              </div>
            </div>
          )}

          {preview && !parsing && step === 'mapping' && (
            <div className="mt-6 bg-white dark:bg-zinc-800 shadow sm:rounded-lg p-6 border border-gray-200 dark:border-zinc-700">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg leading-6 font-medium text-gray-900 dark:text-white">Column Mapping</h3>
                <button
                  onClick={handleBackToMapping}
                  className="inline-flex items-center text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
                >
                  <ArrowLeft className="h-4 w-4 mr-1" />
                  Back to Preview
                </button>
              </div>

              <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
                Map spreadsheet columns to recipient fields. Required fields are marked with <span className="text-red-500">*</span>.
              </p>

              <div className="space-y-4">
                {MAPPING_FIELDS.map((field) => {
                  const currentValue = mapping[field.key];
                  const isRequired = field.required;
                  const obviousMatch = availableHeaders.find((h) => getObviousMatch(h, field.key)) ?? null;

                  return (
                    <div key={field.key} className="flex items-start justify-between gap-4">
                      <div className="flex-1">
                        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                          {field.label}
                          {isRequired && <span className="text-red-500 ml-0.5">*</span>}
                        </label>
                        <select
                          value={currentValue ?? ''}
                          onChange={(e) => updateMapping(field.key, e.target.value || null)}
                          className="block w-full rounded-md border border-gray-300 dark:border-zinc-600 shadow-sm px-3 py-2 text-sm text-gray-900 dark:text-white bg-white dark:bg-zinc-900 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                        >
                          <option value="">Do not import</option>
                          {availableHeaders.map((header) => {
                            const isUsed = isColumnUsed(header, field.key);
                            return (
                              <option key={header} value={header} disabled={isUsed}>
                                {header || '(empty)'}
                                {isUsed ? ' (already mapped)' : ''}
                              </option>
                            );
                          })}
                        </select>
                      </div>
                      {obviousMatch && currentValue !== obviousMatch && (
                        <button
                          type="button"
                          onClick={() => updateMapping(field.key, obviousMatch)}
                          className="inline-flex items-center px-2 py-1 text-xs text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300"
                          title={`Auto-match: ${obviousMatch}`}
                        >
                          Auto-match
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>

              {mappingError && (
                <div className="mt-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-md flex items-start">
                  <AlertCircle className="h-5 w-5 text-red-500 mr-2 flex-shrink-0 mt-0.5" />
                  <span className="text-sm text-red-700 dark:text-red-400">{mappingError}</span>
                </div>
              )}

              <div className="mt-4 p-3 bg-gray-50 dark:bg-zinc-900 rounded-md">
                <p className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-2">Mapping Summary</p>
                <div className="space-y-1">
                  {MAPPING_FIELDS.map((field) => {
                    const currentValue = mapping[field.key];
                    return (
                      <div key={field.key} className="flex justify-between text-sm">
                        <span className="text-gray-700 dark:text-gray-300">{field.label}</span>
                        <span className="text-gray-900 dark:text-white">
                          {currentValue ? (
                            <span className="inline-flex items-center">
                              <Check className="h-3 w-3 text-green-500 mr-1" />
                              {currentValue}
                            </span>
                          ) : (
                            <span className="text-gray-400">Do not import</span>
                          )}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>

              <p className="mt-4 text-xs text-gray-400 dark:text-gray-500">
                Nothing has been imported yet.
              </p>

              <div className="mt-6 flex justify-end space-x-3">
                <button
                  onClick={() => setStep('upload')}
                  className="inline-flex items-center px-4 py-2 border border-gray-300 dark:border-zinc-600 shadow-sm text-sm font-medium rounded-md text-gray-700 dark:text-gray-300 bg-white dark:bg-zinc-800 hover:bg-gray-50 dark:hover:bg-zinc-700"
                >
                  <ArrowLeft className="h-4 w-4 mr-1" />
                  Back to Preview
                </button>
                <button
                  onClick={handleContinueMapping}
                  disabled={!canContinueMapping}
                  className="inline-flex items-center px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Continue
                  <ArrowRight className="h-4 w-4 ml-1" />
                </button>
              </div>
            </div>
          )}

          {preview && !parsing && step === 'validate' && (
            <div className="mt-6 bg-white dark:bg-zinc-800 shadow sm:rounded-lg p-6 border border-gray-200 dark:border-zinc-700">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg leading-6 font-medium text-gray-900 dark:text-white">Validation & Normalization</h3>
                <button
                  onClick={handleBackToMapping}
                  className="inline-flex items-center text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
                >
                  <ArrowLeft className="h-4 w-4 mr-1" />
                  Back to Column Mapping
                </button>
              </div>

              {duplicateError && (
                <div className="mt-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-md flex items-start">
                  <AlertCircle className="h-5 w-5 text-red-500 mr-2 flex-shrink-0 mt-0.5" />
                  <span className="text-sm text-red-700 dark:text-red-400">{duplicateError}</span>
                </div>
              )}

              <div className="mt-4 flex flex-wrap gap-4">
                <div className="px-3 py-2 bg-green-50 dark:bg-green-900/20 rounded-md">
                  <p className="text-sm text-gray-500 dark:text-gray-400">Total Rows</p>
                  <p className="text-lg font-semibold text-gray-900 dark:text-white">{importRows.length}</p>
                </div>
                <div className="px-3 py-2 bg-green-50 dark:bg-green-900/20 rounded-md">
                  <p className="text-sm text-gray-500 dark:text-gray-400">Valid Rows</p>
                  <p className="text-lg font-semibold text-green-700 dark:text-green-300">{validRows.length}</p>
                </div>
                <div className="px-3 py-2 bg-red-50 dark:bg-red-900/20 rounded-md">
                  <p className="text-sm text-gray-500 dark:text-gray-400">Invalid Rows</p>
                  <p className="text-lg font-semibold text-red-700 dark:text-red-300">{invalidRows.length}</p>
                </div>
              </div>

              <div className="mt-4 overflow-x-auto border border-gray-200 dark:border-zinc-700 rounded-md">
                <table className="min-w-full divide-y divide-gray-200 dark:divide-zinc-700">
                  <thead className="bg-gray-50 dark:bg-zinc-900">
                    <tr>
                      <th scope="col" className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Row</th>
                      <th scope="col" className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Name</th>
                      <th scope="col" className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">WhatsApp Number</th>
                      <th scope="col" className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Normalized Phone</th>
                      <th scope="col" className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Status</th>
                      <th scope="col" className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Errors</th>
                    </tr>
                  </thead>
                  <tbody className="bg-white dark:bg-zinc-800 divide-y divide-gray-200 dark:divide-zinc-700">
                    {importRows.map((row) => (
                      <tr key={row.rowNumber}>
                        <td className="px-4 py-2 whitespace-nowrap text-sm text-gray-500 dark:text-gray-300">{row.rowNumber}</td>
                        <td className="px-4 py-2 whitespace-nowrap text-sm text-gray-900 dark:text-white">{row.name || '<missing>'}</td>
                        <td className="px-4 py-2 whitespace-nowrap text-sm text-gray-900 dark:text-white">{row.whatsappNumber || '<missing>'}</td>
                        <td className="px-4 py-2 whitespace-nowrap text-sm text-gray-900 dark:text-white">{row.normalizedPhone || '<invalid>'}</td>
                        <td className="px-4 py-2 whitespace-nowrap">
                          <span className={getStatusBadge(row.isValid)}>
                            {row.isValid ? 'Valid' : 'Invalid'}
                          </span>
                        </td>
                        <td className="px-4 py-2 text-sm text-red-600 dark:text-red-400">
                          {row.errors.length > 0 ? row.errors.join(', ') : '-'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <p className="mt-4 text-xs text-gray-400 dark:text-gray-500">
                Nothing has been imported yet.
              </p>

              <div className="mt-6 flex justify-end space-x-3">
                <button
                  onClick={handleBackToMapping}
                  className="inline-flex items-center px-4 py-2 border border-gray-300 dark:border-zinc-600 shadow-sm text-sm font-medium rounded-md text-gray-700 dark:text-gray-300 bg-white dark:bg-zinc-800 hover:bg-gray-50 dark:hover:bg-zinc-700"
                >
                  <ArrowLeft className="h-4 w-4 mr-1" />
                  Back to Column Mapping
                </button>
                <button
                  onClick={resetSelection}
                  className="inline-flex items-center px-4 py-2 border border-gray-300 dark:border-zinc-600 shadow-sm text-sm font-medium rounded-md text-gray-700 dark:text-gray-300 bg-white dark:bg-zinc-800 hover:bg-gray-50 dark:hover:bg-zinc-700"
                >
                  Start Over
                </button>
                <button
                  onClick={handleRunDuplicateCheck}
                  disabled={duplicateChecking}
                  className="inline-flex items-center px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {duplicateChecking ? 'Checking duplicates...' : 'Continue to Duplicate Check'}
                  <ArrowRight className="h-4 w-4 ml-1" />
                </button>
              </div>
            </div>
          )}

          {preview && !parsing && step === 'duplicates' && (
            <div className="mt-6 bg-white dark:bg-zinc-800 shadow sm:rounded-lg p-6 border border-gray-200 dark:border-zinc-700">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg leading-6 font-medium text-gray-900 dark:text-white">Duplicate Detection</h3>
                <button
                  onClick={handleBackToValidation}
                  className="inline-flex items-center text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
                >
                  <ArrowLeft className="h-4 w-4 mr-1" />
                  Back to Validation
                </button>
              </div>

              <p className="text-sm text-gray-500 dark:text-gray-400">
                Every valid row has been compared with the existing recipients and with the other rows in this file,
                using the canonical normalized phone number. Duplicates are only reported here — nothing has been changed.
              </p>

              <div className="mt-4 flex flex-wrap gap-4">
                <div className="px-3 py-2 bg-gray-50 dark:bg-zinc-900 rounded-md">
                  <p className="text-sm text-gray-500 dark:text-gray-400">Total Rows</p>
                  <p className="text-lg font-semibold text-gray-900 dark:text-white">{duplicateSummary.totalRows}</p>
                </div>
                <div className="px-3 py-2 bg-green-50 dark:bg-green-900/20 rounded-md">
                  <p className="text-sm text-gray-500 dark:text-gray-400">Valid Rows</p>
                  <p className="text-lg font-semibold text-green-700 dark:text-green-300">{duplicateSummary.validRows}</p>
                </div>
                <div className="px-3 py-2 bg-red-50 dark:bg-red-900/20 rounded-md">
                  <p className="text-sm text-gray-500 dark:text-gray-400">Invalid Rows</p>
                  <p className="text-lg font-semibold text-red-700 dark:text-red-300">{duplicateSummary.invalidRows}</p>
                </div>
                <div className="px-3 py-2 bg-amber-50 dark:bg-amber-900/20 rounded-md">
                  <p className="text-sm text-gray-500 dark:text-gray-400">Existing Database Duplicates</p>
                  <p className="text-lg font-semibold text-amber-700 dark:text-amber-300">{duplicateSummary.existingDatabaseDuplicates}</p>
                </div>
                <div className="px-3 py-2 bg-yellow-50 dark:bg-yellow-900/20 rounded-md">
                  <p className="text-sm text-gray-500 dark:text-gray-400">Within-File Duplicates (rows)</p>
                  <p className="text-lg font-semibold text-yellow-700 dark:text-yellow-300">{duplicateSummary.withinFileDuplicates}</p>
                </div>
                <div className="px-3 py-2 bg-yellow-50 dark:bg-yellow-900/20 rounded-md">
                  <p className="text-sm text-gray-500 dark:text-gray-400">Within-File Duplicate Numbers (groups)</p>
                  <p className="text-lg font-semibold text-yellow-700 dark:text-yellow-300">{duplicateSummary.withinFileDuplicateGroups}</p>
                </div>
                <div className="px-3 py-2 bg-green-50 dark:bg-green-900/20 rounded-md">
                  <p className="text-sm text-gray-500 dark:text-gray-400">Unique Valid Rows</p>
                  <p className="text-lg font-semibold text-green-700 dark:text-green-300">{duplicateSummary.uniqueValidRows}</p>
                </div>
              </div>

              <div className="mt-4 overflow-x-auto border border-gray-200 dark:border-zinc-700 rounded-md">
                <table className="min-w-full divide-y divide-gray-200 dark:divide-zinc-700">
                  <thead className="bg-gray-50 dark:bg-zinc-900">
                    <tr>
                      <th scope="col" className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Row</th>
                      <th scope="col" className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Name</th>
                      <th scope="col" className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">WhatsApp Number</th>
                      <th scope="col" className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Normalized Phone</th>
                      <th scope="col" className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Validation Status</th>
                      <th scope="col" className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Duplicate Status</th>
                      <th scope="col" className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Details</th>
                    </tr>
                  </thead>
                  <tbody className="bg-white dark:bg-zinc-800 divide-y divide-gray-200 dark:divide-zinc-700">
                    {importRows.map((row) => (
                      <tr key={row.rowNumber}>
                        <td className="px-4 py-2 whitespace-nowrap text-sm text-gray-500 dark:text-gray-300">{row.rowNumber}</td>
                        <td className="px-4 py-2 whitespace-nowrap text-sm text-gray-900 dark:text-white">{row.name || '<missing>'}</td>
                        <td className="px-4 py-2 whitespace-nowrap text-sm text-gray-900 dark:text-white">{row.whatsappNumber || '<missing>'}</td>
                        <td className="px-4 py-2 whitespace-nowrap text-sm text-gray-900 dark:text-white">{row.normalizedPhone || '<invalid>'}</td>
                        <td className="px-4 py-2 text-sm text-gray-900 dark:text-white">
                          <span className={getStatusBadge(row.isValid)}>
                            {row.isValid ? 'Valid' : 'Invalid'}
                          </span>
                          {row.errors.length > 0 && (
                            <div className="mt-1 text-xs text-red-600 dark:text-red-400">{row.errors.join(', ')}</div>
                          )}
                        </td>
                        <td className="px-4 py-2 whitespace-nowrap">
                          <span className={getRowStatusBadge(row.status)}>
                            {getRowStatusLabel(row.status)}
                          </span>
                        </td>
                        <td className="px-4 py-2 text-sm text-gray-500 dark:text-gray-300">{describeDuplicateStatus(row)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <p className="mt-4 text-xs text-gray-400 dark:text-gray-500">
                Nothing has been imported yet. What to do with the duplicates above is not decided in this step.
              </p>

              <div className="mt-6 flex justify-end space-x-3">
                <button
                  onClick={handleBackToMapping}
                  className="inline-flex items-center px-4 py-2 border border-gray-300 dark:border-zinc-600 shadow-sm text-sm font-medium rounded-md text-gray-700 dark:text-gray-300 bg-white dark:bg-zinc-800 hover:bg-gray-50 dark:hover:bg-zinc-700"
                >
                  <ArrowLeft className="h-4 w-4 mr-1" />
                  Back to Column Mapping
                </button>
                <button
                  onClick={resetSelection}
                  className="inline-flex items-center px-4 py-2 border border-gray-300 dark:border-zinc-600 shadow-sm text-sm font-medium rounded-md text-gray-700 dark:text-gray-300 bg-white dark:bg-zinc-800 hover:bg-gray-50 dark:hover:bg-zinc-700"
                >
                  Start Over
                </button>
                <button
                  onClick={handleBackToValidation}
                  className="inline-flex items-center px-4 py-2 border border-gray-300 dark:border-zinc-600 shadow-sm text-sm font-medium rounded-md text-gray-700 dark:text-gray-300 bg-white dark:bg-zinc-800 hover:bg-gray-50 dark:hover:bg-zinc-700"
                >
                  <ArrowLeft className="h-4 w-4 mr-1" />
                  Back to Validation
                </button>
                <button
                  onClick={handleContinueToPreview}
                  className="inline-flex items-center px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700"
                >
                  Continue to Import Preview
                  <ArrowRight className="h-4 w-4 ml-1" />
                </button>
              </div>
            </div>
          )}

          {preview && !parsing && step === 'preview' && (
            <div className="mt-6 bg-white dark:bg-zinc-800 shadow sm:rounded-lg p-6 border border-gray-200 dark:border-zinc-700">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg leading-6 font-medium text-gray-900 dark:text-white">Import Preview</h3>
                <button
                  onClick={handleBackToDuplicates}
                  className="inline-flex items-center text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
                >
                  <ArrowLeft className="h-4 w-4 mr-1" />
                  Back to Duplicate Check
                </button>
              </div>

              <div className="p-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-md">
                <p className="text-sm font-semibold text-blue-800 dark:text-blue-200">
                  {previewSummary.selectedForImport} recipients are selected for import.
                </p>
                <p className="text-sm text-blue-700 dark:text-blue-300 mt-1">
                  Nothing has been imported yet. This preview only reports the current decisions — no row has been written to the database.
                </p>
              </div>

              <div className="mt-4 flex flex-wrap gap-4">
                <div className="px-3 py-2 bg-gray-50 dark:bg-zinc-900 rounded-md">
                  <p className="text-sm text-gray-500 dark:text-gray-400">Total Rows</p>
                  <p className="text-lg font-semibold text-gray-900 dark:text-white">{previewSummary.totalRows}</p>
                </div>
                <div className="px-3 py-2 bg-green-50 dark:bg-green-900/20 rounded-md">
                  <p className="text-sm text-gray-500 dark:text-gray-400">Valid Rows</p>
                  <p className="text-lg font-semibold text-green-700 dark:text-green-300">{previewSummary.validRows}</p>
                </div>
                <div className="px-3 py-2 bg-red-50 dark:bg-red-900/20 rounded-md">
                  <p className="text-sm text-gray-500 dark:text-gray-400">Invalid Rows</p>
                  <p className="text-lg font-semibold text-red-700 dark:text-red-300">{previewSummary.invalidRows}</p>
                </div>
                <div className="px-3 py-2 bg-amber-50 dark:bg-amber-900/20 rounded-md">
                  <p className="text-sm text-gray-500 dark:text-gray-400">Existing Database Duplicates</p>
                  <p className="text-lg font-semibold text-amber-700 dark:text-amber-300">{previewSummary.existingDatabaseDuplicates}</p>
                </div>
                <div className="px-3 py-2 bg-yellow-50 dark:bg-yellow-900/20 rounded-md">
                  <p className="text-sm text-gray-500 dark:text-gray-400">Within-File Duplicate Rows</p>
                  <p className="text-lg font-semibold text-yellow-700 dark:text-yellow-300">{previewSummary.withinFileDuplicateRows}</p>
                </div>
                <div className="px-3 py-2 bg-green-50 dark:bg-green-900/20 rounded-md">
                  <p className="text-sm text-gray-500 dark:text-gray-400">Selected For Import</p>
                  <p className="text-lg font-semibold text-green-700 dark:text-green-300">{previewSummary.selectedForImport}</p>
                </div>
                <div className="px-3 py-2 bg-gray-50 dark:bg-zinc-900 rounded-md">
                  <p className="text-sm text-gray-500 dark:text-gray-400">Skipped</p>
                  <p className="text-lg font-semibold text-gray-900 dark:text-white">{previewSummary.skippedRows}</p>
                </div>
              </div>

              <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  Only valid rows without duplicates can be selected for import.
                </p>
                <div className="flex space-x-3">
                  <button
                    onClick={handleSelectAllImportable}
                    className="inline-flex items-center px-3 py-1.5 border border-gray-300 dark:border-zinc-600 shadow-sm text-sm font-medium rounded-md text-gray-700 dark:text-gray-300 bg-white dark:bg-zinc-800 hover:bg-gray-50 dark:hover:bg-zinc-700"
                  >
                    Select All Eligible Rows
                  </button>
                  <button
                    onClick={handleDeselectAll}
                    className="inline-flex items-center px-3 py-1.5 border border-gray-300 dark:border-zinc-600 shadow-sm text-sm font-medium rounded-md text-gray-700 dark:text-gray-300 bg-white dark:bg-zinc-800 hover:bg-gray-50 dark:hover:bg-zinc-700"
                  >
                    Deselect All
                  </button>
                </div>
              </div>

              <div className="mt-4 overflow-x-auto border border-gray-200 dark:border-zinc-700 rounded-md">
                <table className="min-w-full divide-y divide-gray-200 dark:divide-zinc-700">
                  <thead className="bg-gray-50 dark:bg-zinc-900">
                    <tr>
                      <th scope="col" className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Row</th>
                      <th scope="col" className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Name</th>
                      <th scope="col" className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">WhatsApp Number</th>
                      <th scope="col" className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Normalized Phone</th>
                      <th scope="col" className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Validation</th>
                      <th scope="col" className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Duplicate Status</th>
                      <th scope="col" className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Decision</th>
                      <th scope="col" className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Details</th>
                    </tr>
                  </thead>
                  <tbody className="bg-white dark:bg-zinc-800 divide-y divide-gray-200 dark:divide-zinc-700">
                    {importRows.map((row) => {
                      const decision = getRowDecision(importSelection, row);
                      const editable = canChangeImportDecision(row);
                      return (
                        <tr key={row.rowNumber}>
                          <td className="px-4 py-2 whitespace-nowrap text-sm text-gray-500 dark:text-gray-300">{row.rowNumber}</td>
                          <td className="px-4 py-2 whitespace-nowrap text-sm text-gray-900 dark:text-white">{row.name || '<missing>'}</td>
                          <td className="px-4 py-2 whitespace-nowrap text-sm text-gray-900 dark:text-white">{row.whatsappNumber || '<missing>'}</td>
                          <td className="px-4 py-2 whitespace-nowrap text-sm text-gray-900 dark:text-white">{row.normalizedPhone || '—'}</td>
                          <td className="px-4 py-2 text-sm text-gray-900 dark:text-white">
                            <span className={getStatusBadge(row.isValid)}>
                              {row.isValid ? 'Valid' : 'Invalid'}
                            </span>
                            {row.errors.length > 0 && (
                              <div className="mt-1 text-xs text-red-600 dark:text-red-400">{row.errors.join(', ')}</div>
                            )}
                          </td>
                          <td className="px-4 py-2 whitespace-nowrap">
                            <span className={getRowStatusBadge(row.status)}>
                              {getRowStatusLabel(row.status)}
                            </span>
                          </td>
                          <td className="px-4 py-2 whitespace-nowrap">
                            <div className="flex flex-col gap-1">
                              <span className={getDecisionBadgeClass(decision)}>
                                {decision}
                              </span>
                              <div className="inline-flex" role="group" aria-label={`Import decision for row ${row.rowNumber}`}>
                                <button
                                  type="button"
                                  disabled={!editable}
                                  onClick={() => handleDecisionChange(row.rowNumber, 'IMPORT')}
                                  className={getDecisionButtonClass(decision, true)}
                                  title={editable ? 'Select this row for import' : 'Only valid rows without duplicates can be imported'}
                                >
                                  IMPORT
                                </button>
                                <button
                                  type="button"
                                  disabled={!editable}
                                  onClick={() => handleDecisionChange(row.rowNumber, 'SKIP')}
                                  className={getDecisionButtonClass(decision, false)}
                                  title={editable ? 'Skip this row' : 'This row is locked to SKIP'}
                                >
                                  SKIP
                                </button>
                              </div>
                              {!editable && (
                                <span className="text-xs text-gray-400 dark:text-gray-500">Locked to SKIP</span>
                              )}
                            </div>
                          </td>
                          <td className="px-4 py-2 text-sm text-gray-500 dark:text-gray-300">{getImportDecisionDetails(row, decision)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <p className="mt-4 text-xs text-gray-400 dark:text-gray-500">
                Nothing has been imported yet. Skipped rows remain visible above and nothing has been written to the database.
              </p>

              <div className="mt-6 flex justify-end space-x-3">
                <button
                  onClick={handleBackToDuplicates}
                  className="inline-flex items-center px-4 py-2 border border-gray-300 dark:border-zinc-600 shadow-sm text-sm font-medium rounded-md text-gray-700 dark:text-gray-300 bg-white dark:bg-zinc-800 hover:bg-gray-50 dark:hover:bg-zinc-700"
                >
                  <ArrowLeft className="h-4 w-4 mr-1" />
                  Back to Duplicate Check
                </button>
                <button
                  onClick={resetSelection}
                  className="inline-flex items-center px-4 py-2 border border-gray-300 dark:border-zinc-600 shadow-sm text-sm font-medium rounded-md text-gray-700 dark:text-gray-300 bg-white dark:bg-zinc-800 hover:bg-gray-50 dark:hover:bg-zinc-700"
                >
                  Start Over
                </button>
                <button
                  onClick={handleContinueToConfirmation}
                  className="inline-flex items-center px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700"
                >
                  Continue to Import Confirmation
                  <ArrowRight className="h-4 w-4 ml-1" />
                </button>
              </div>
            </div>
          )}

          {preview && !parsing && step === 'confirmation' && (
            <div className="mt-6 bg-white dark:bg-zinc-800 shadow sm:rounded-lg p-6 border border-gray-200 dark:border-zinc-700">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg leading-6 font-medium text-gray-900 dark:text-white">Import Confirmation</h3>
                <button
                  onClick={handleBackToPreview}
                  className="inline-flex items-center text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
                >
                  <ArrowLeft className="h-4 w-4 mr-1" />
                  Back to Import Preview
                </button>
              </div>

              <div className="p-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-md">
                <p className="text-sm font-semibold text-blue-800 dark:text-blue-200">
                  {previewSummary.selectedForImport} recipients are selected for import.
                </p>
                <p className="text-sm text-blue-700 dark:text-blue-300 mt-1">
                  Nothing has been imported yet. Only the {previewSummary.selectedForImport} selected eligible row(s) will be added; {previewSummary.skippedRows} row(s) will be skipped.
                </p>
                <p className="text-sm text-blue-700 dark:text-blue-300 mt-1">
                  Existing recipients are never overwritten — a row whose phone number already exists is skipped instead.
                </p>
              </div>

              {importError && (
                <div className="mt-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-md flex items-start">
                  <AlertCircle className="h-5 w-5 text-red-500 mr-2 flex-shrink-0" />
                  <p className="text-sm text-red-700 dark:text-red-300">{importError}</p>
                </div>
              )}

              <div className="mt-6 flex justify-end space-x-3">
                <button
                  onClick={handleBackToPreview}
                  disabled={importing}
                  className="inline-flex items-center px-4 py-2 border border-gray-300 dark:border-zinc-600 shadow-sm text-sm font-medium rounded-md text-gray-700 dark:text-gray-300 bg-white dark:bg-zinc-800 hover:bg-gray-50 dark:hover:bg-zinc-700 disabled:opacity-50"
                >
                  <ArrowLeft className="h-4 w-4 mr-1" />
                  Back to Import Preview
                </button>
                <button
                  onClick={handleConfirmImport}
                  disabled={importing}
                  className="inline-flex items-center px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50"
                >
                  <Check className="h-4 w-4 mr-1" />
                  {importing ? 'Importing...' : 'Confirm Import'}
                </button>
              </div>
            </div>
          )}

          {step === 'result' && importResult && (
            <div className="mt-6 bg-white dark:bg-zinc-800 shadow sm:rounded-lg p-6 border border-gray-200 dark:border-zinc-700">
              <h3 className="text-lg leading-6 font-medium text-gray-900 dark:text-white">Import Complete</h3>
              <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                The import finished. New recipients were added; existing recipients were left untouched.
              </p>

              <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div className="px-3 py-2 bg-gray-50 dark:bg-zinc-900 rounded-md">
                  <p className="text-sm text-gray-500 dark:text-gray-400">Total processed</p>
                  <p className="text-lg font-semibold text-gray-900 dark:text-white">{importResult.summary.total}</p>
                </div>
                <div className="px-3 py-2 bg-green-50 dark:bg-green-900/20 rounded-md">
                  <p className="text-sm text-gray-500 dark:text-gray-400">Created</p>
                  <p className="text-lg font-semibold text-green-700 dark:text-green-300">{importResult.summary.created}</p>
                </div>
                <div className="px-3 py-2 bg-amber-50 dark:bg-amber-900/20 rounded-md">
                  <p className="text-sm text-gray-500 dark:text-gray-400">Skipped</p>
                  <p className="text-lg font-semibold text-amber-700 dark:text-amber-300">{importResult.summary.skipped}</p>
                </div>
                <div className="px-3 py-2 bg-red-50 dark:bg-red-900/20 rounded-md">
                  <p className="text-sm text-gray-500 dark:text-gray-400">Failed</p>
                  <p className="text-lg font-semibold text-red-700 dark:text-red-300">{importResult.summary.failed}</p>
                </div>
              </div>

              <div className="mt-4 overflow-x-auto border border-gray-200 dark:border-zinc-700 rounded-md">
                <table className="min-w-full divide-y divide-gray-200 dark:divide-zinc-700">
                  <thead className="bg-gray-50 dark:bg-zinc-900">
                    <tr>
                      <th scope="col" className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Row</th>
                      <th scope="col" className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Name</th>
                      <th scope="col" className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">WhatsApp Number</th>
                      <th scope="col" className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Normalized Phone</th>
                      <th scope="col" className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Result</th>
                      <th scope="col" className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Reason</th>
                    </tr>
                  </thead>
                  <tbody className="bg-white dark:bg-zinc-800 divide-y divide-gray-200 dark:divide-zinc-700">
                    {importResult.results.map((result: ImportRowResult) => (
                      <tr key={result.rowNumber}>
                        <td className="px-4 py-2 whitespace-nowrap text-sm text-gray-500 dark:text-gray-300">{result.rowNumber}</td>
                        <td className="px-4 py-2 whitespace-nowrap text-sm text-gray-900 dark:text-white">{result.name || '<missing>'}</td>
                        <td className="px-4 py-2 whitespace-nowrap text-sm text-gray-900 dark:text-white">{result.whatsappNumber || '<missing>'}</td>
                        <td className="px-4 py-2 whitespace-nowrap text-sm text-gray-500 dark:text-gray-300">{result.normalizedPhone || '-'}</td>
                        <td className="px-4 py-2 whitespace-nowrap text-sm">
                          <span className={getImportResultBadgeClass(result.status)}>{result.status}</span>
                        </td>
                        <td className="px-4 py-2 text-sm text-gray-500 dark:text-gray-300">{result.reason || '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="mt-6 flex justify-end">
                <button
                  onClick={handleBackToRecipients}
                  className="inline-flex items-center px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700"
                >
                  Back to Recipients
                  <ArrowRight className="h-4 w-4 ml-1" />
                </button>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}