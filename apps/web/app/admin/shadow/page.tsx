'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import RoleStandaloneView from '@/components/RoleStandaloneView';

type IntakeStatus = 'Pending' | 'Classified' | 'Staged' | 'Approved' | 'Rejected' | 'Imported';
type ConfidenceLevel = 'Low' | 'Medium' | 'High';
type DataType =
  | 'System'
  | 'Command'
  | 'Workout'
  | 'Biometric'
  | 'Coach Note'
  | 'Video'
  | 'Athlete Check-In'
  | 'Parent Observation'
  | 'Board Document'
  | 'Policy Draft'
  | 'Incident Note'
  | 'Assessment Result'
  | 'File Intake';

type IntakeDestination =
  | 'Athlete Workspace'
  | 'Coach Workspace'
  | 'Parent Hub'
  | 'Admin Hub'
  | 'Board Hub'
  | 'Capability Registry'
  | 'Evidence Library'
  | 'Incident / Safety Log'
  | 'SHADOW Local State';

interface ConsoleLogEntry {
  id: string;
  timestamp: string;
  source: string;
  dataType: DataType;
  status: string;
  message: string;
  destination?: IntakeDestination;
}

interface IntakeItem {
  id: string;
  intakeCaseId: string;
  itemName: string;
  dataType: DataType;
  source: string;
  suggestedDestination: IntakeDestination;
  status: IntakeStatus;
  reviewNeeded: boolean;
  requiresJasonReview: boolean;
  detectedType: DataType;
  confidence: ConfidenceLevel;
  notes: string;
  destinationRoute: string;
  timestamp: string;
  lastUpdatedAt: string;
}

interface TelemetryEvent {
  timestamp: string;
  event:
    | 'file upload clicked'
    | 'quick add created'
    | 'command submitted'
    | 'item classified'
    | 'item staged'
    | 'item approved'
    | 'item rejected'
    | 'item imported';
  payload: Record<string, unknown>;
}

interface ShadowUploadResponse {
  ok: boolean;
  intake_id: string;
  intake_case_id: string;
  intake_document_id: string;
  document_type: string;
  classification: string;
  routed_queue: string;
  review_status: string;
}

interface ReviewQueueApiResponse {
  ok: boolean;
  queue: Array<{
    intake_case_id: string;
    status: 'pending_review' | 'approved' | 'rejected' | 'promoted';
    summary: string;
    primary_athlete_id: string | null;
    created_at: string;
    updated_at: string;
    document_count: number;
  }>;
}

type QueueSort = 'newest' | 'oldest' | 'status';
type HistorySort = 'newest' | 'oldest';

const DESTINATION_OPTIONS: IntakeDestination[] = [
  'Athlete Workspace',
  'Coach Workspace',
  'Parent Hub',
  'Admin Hub',
  'Board Hub',
  'Capability Registry',
  'Evidence Library',
  'Incident / Safety Log',
  'SHADOW Local State',
];

const QUICK_ADD_OPTIONS: Array<{ label: DataType; source: string; destination: IntakeDestination; route: string }> = [
  { label: 'Workout', source: 'Coach', destination: 'Coach Workspace', route: '/coach/review-queue' },
  { label: 'Biometric', source: 'Athlete Device', destination: 'Athlete Workspace', route: '/athlete/dashboard' },
  { label: 'Coach Note', source: 'Coach', destination: 'Coach Workspace', route: '/coach/review-queue' },
  { label: 'Video', source: 'Media Upload', destination: 'Evidence Library', route: '/evidence' },
  { label: 'Athlete Check-In', source: 'Athlete', destination: 'Athlete Workspace', route: '/athlete/dashboard' },
  { label: 'Parent Observation', source: 'Parent / Guardian', destination: 'Parent Hub', route: '/parent/dashboard' },
  { label: 'Board Document', source: 'Board', destination: 'Board Hub', route: '/board' },
  { label: 'Policy Draft', source: 'Admin', destination: 'Capability Registry', route: '/admin' },
  { label: 'Incident Note', source: 'Safety', destination: 'Incident / Safety Log', route: '/audit' },
  { label: 'Assessment Result', source: 'Program Team', destination: 'Evidence Library', route: '/evidence' },
];

function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-fallback-id`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function routeForDestination(destination: IntakeDestination): string {
  if (destination === 'Athlete Workspace') return '/athlete/dashboard';
  if (destination === 'Coach Workspace') return '/coach/review-queue';
  if (destination === 'Parent Hub') return '/parent/dashboard';
  if (destination === 'Admin Hub') return '/admin';
  if (destination === 'Board Hub') return '/board';
  if (destination === 'Capability Registry') return '/admin';
  if (destination === 'Evidence Library') return '/evidence';
  if (destination === 'Incident / Safety Log') return '/audit';
  return '/admin/shadow';
}

function parsePromotionPayloadFromNotes(notes: string): Record<string, unknown> | null {
  const trimmed = notes.trim();
  if (!trimmed.startsWith('{')) {
    return null;
  }

  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function createMockIntakeItem(dataType: DataType, source: string, destination: IntakeDestination, route?: string): IntakeItem {
  const timestamp = nowIso();
  return {
    id: newId(),
    intakeCaseId: newId(),
    itemName: `${dataType} Intake ${timestamp.slice(11, 19)}`,
    dataType,
    source,
    suggestedDestination: destination,
    status: 'Pending',
    reviewNeeded: true,
    requiresJasonReview: true,
    detectedType: dataType,
    confidence: 'Medium',
    notes: 'Pending classification review by SHADOW admin.',
    destinationRoute: route ?? routeForDestination(destination),
    timestamp,
    lastUpdatedAt: timestamp,
  };
}

function statusChipClasses(status: IntakeStatus): string {
  if (status === 'Pending') return 'border-[#8b4444] bg-[#341515] text-[#f0c4c4]';
  if (status === 'Classified') return 'border-[#a66424] bg-[#2d2214] text-[#f7d9b0]';
  if (status === 'Staged') return 'border-[#b38a3c] bg-[#2f2817] text-[#f5e3b5]';
  if (status === 'Approved') return 'border-[#3f8b5b] bg-[#162a1d] text-[#c9f0d7]';
  if (status === 'Rejected') return 'border-[#a13f3f] bg-[#2c1414] text-[#f2c3c3]';
  return 'border-[#46809b] bg-[#15242e] text-[#c8e6f2]';
}

function toDataType(value: string): DataType {
  const known: DataType[] = [
    'System',
    'Command',
    'Workout',
    'Biometric',
    'Coach Note',
    'Video',
    'Athlete Check-In',
    'Parent Observation',
    'Board Document',
    'Policy Draft',
    'Incident Note',
    'Assessment Result',
    'File Intake',
  ];
  return known.includes(value as DataType) ? (value as DataType) : 'File Intake';
}

function toDestination(value: string): IntakeDestination {
  return DESTINATION_OPTIONS.includes(value as IntakeDestination)
    ? (value as IntakeDestination)
    : 'SHADOW Local State';
}

function fromBackendStatus(status: 'pending_review' | 'approved' | 'rejected' | 'promoted'): IntakeStatus {
  if (status === 'approved') return 'Approved';
  if (status === 'rejected') return 'Rejected';
  if (status === 'promoted') return 'Imported';
  return 'Pending';
}

export default function AdminShadowConsolePage() {
  const [consoleLogs, setConsoleLogs] = useState<ConsoleLogEntry[]>([
    {
      id: newId(),
      timestamp: nowIso(),
      source: 'Admin',
      dataType: 'System',
      status: 'Initialized',
      message: 'SHADOW Admin Console initialized.',
      destination: 'SHADOW Local State',
    },
  ]);
  const [commandInput, setCommandInput] = useState('');
  const [pendingQueue, setPendingQueue] = useState<IntakeItem[]>([
    createMockIntakeItem('Policy Draft', 'Admin', 'Capability Registry', '/admin'),
    createMockIntakeItem('Incident Note', 'Safety', 'Incident / Safety Log', '/audit'),
  ]);
  const [importHistory, setImportHistory] = useState<IntakeItem[]>([]);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [uploadedFileName, setUploadedFileName] = useState('');
  const [showHistory, setShowHistory] = useState(false);
  const [queueFilterStatus, setQueueFilterStatus] = useState<'ALL' | IntakeStatus>('ALL');
  const [queueSort, setQueueSort] = useState<QueueSort>('newest');
  const [historyFilterStatus, setHistoryFilterStatus] = useState<'ALL' | IntakeStatus>('ALL');
  const [historySort, setHistorySort] = useState<HistorySort>('newest');
  const [telemetryEvents, setTelemetryEvents] = useState<TelemetryEvent[]>([]);
  const [showTelemetry, setShowTelemetry] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [lastIngestSummary, setLastIngestSummary] = useState<ShadowUploadResponse | null>(null);
  const logsEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const handleItemActionRef = useRef(handleItemAction);

  useEffect(() => {
    handleItemActionRef.current = handleItemAction;
  });

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [consoleLogs]);

  useEffect(() => {
    void refreshBackendQueue().catch((error) => {
      appendConsoleLog({
        source: 'SHADOW',
        dataType: 'System',
        status: 'Queue Load Failed',
        message: error instanceof Error ? error.message : 'Failed to load backend queue',
        destination: 'SHADOW Local State',
      });
    });
  }, []);

  const selectedItem = useMemo(() => pendingQueue.find((item) => item.id === selectedItemId) ?? null, [pendingQueue, selectedItemId]);

  async function refreshBackendQueue() {
    const response = await fetch('/api/pilot/intake/review-queue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    const payload = (await response.json()) as ReviewQueueApiResponse | { error?: string };
    if (!response.ok || !('ok' in payload)) {
      const message = 'error' in payload && payload.error ? payload.error : 'Failed to load review queue';
      throw new Error(message);
    }

    const mapped: IntakeItem[] = payload.queue.map((entry) => {
      const athleteSuffix = entry.primary_athlete_id ? ` | Athlete: ${entry.primary_athlete_id}` : '';

      return {
      id: entry.intake_case_id,
      intakeCaseId: entry.intake_case_id,
      itemName: entry.summary,
      dataType: 'File Intake',
      source: 'SHADOW Upload',
      suggestedDestination: 'Admin Hub',
      status: fromBackendStatus(entry.status),
      reviewNeeded: entry.status === 'pending_review',
      requiresJasonReview: entry.status === 'pending_review',
      detectedType: 'File Intake',
      confidence: 'Medium',
      notes: `Documents in case: ${entry.document_count}${athleteSuffix}`,
      destinationRoute: '/admin/shadow',
      timestamp: entry.created_at,
      lastUpdatedAt: entry.updated_at,
      };
    });

    setPendingQueue(mapped);
  }

  function appendTelemetry(event: TelemetryEvent['event'], payload: Record<string, unknown>) {
    setTelemetryEvents((prev) => [{ timestamp: nowIso(), event, payload }, ...prev].slice(0, 200));
  }

  function appendConsoleLog(entry: Omit<ConsoleLogEntry, 'id' | 'timestamp'>) {
    setConsoleLogs((prev) => [
      ...prev,
      {
        id: newId(),
        timestamp: nowIso(),
        ...entry,
      },
    ]);
  }

  function applyQueueUpdate(itemId: string, updater: (item: IntakeItem) => IntakeItem) {
    setPendingQueue((current) => current.map((item) => (item.id === itemId ? updater(item) : item)));
  }

  function saveHistorySnapshot(item: IntakeItem) {
    setImportHistory((prev) => [{ ...item }, ...prev].slice(0, 80));
  }

  async function processReviewAction(item: IntakeItem, backendAction: 'approve' | 'reject') {
    const response = await fetch('/api/pilot/intake/review-action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ intake_case_id: item.intakeCaseId, action: backendAction, notes: item.notes }),
    });

    const payload = (await response.json()) as { error?: string };
    if (!response.ok) {
      throw new Error(payload.error || `Failed to ${backendAction} intake case`);
    }

    await refreshBackendQueue();
  }

  async function processPromotion(item: IntakeItem) {
    const promotionPayload = parsePromotionPayloadFromNotes(item.notes);
    if (!promotionPayload) {
      appendConsoleLog({
        source: 'SHADOW',
        dataType: item.dataType,
        status: 'Promotion Blocked',
        message: 'To promote, set Notes to a valid JSON promotion payload.',
        destination: item.suggestedDestination,
      });
      return null;
    }

    const promoteResponse = await fetch('/api/pilot/intake/review-action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        intake_case_id: item.intakeCaseId,
        action: 'promote',
        notes: 'Promoted from SHADOW Admin Console',
        promotion: promotionPayload,
      }),
    });

    const promotePayload = (await promoteResponse.json()) as { error?: string; athlete_id?: string };
    if (!promoteResponse.ok) {
      throw new Error(promotePayload.error || 'Promotion failed');
    }

    await refreshBackendQueue();
    return promotePayload;
  }

  async function handleItemAction(itemId: string, action: 'VIEW' | 'CLASSIFY' | 'STAGE' | 'APPROVE' | 'REJECT' | 'IMPORT') {
    const item = pendingQueue.find((entry) => entry.id === itemId);
    if (!item) {
      return;
    }

    if (action === 'VIEW') {
      setSelectedItemId(itemId);
      appendConsoleLog({
        source: 'Admin',
        dataType: item.dataType,
        status: 'Viewed',
        message: `Viewing intake item ${item.itemName}.`,
        destination: item.suggestedDestination,
      });
      return;
    }

    if (action === 'CLASSIFY') {
      const updated = { ...item, status: 'Classified' as const, lastUpdatedAt: nowIso() };
      applyQueueUpdate(itemId, () => updated);
      saveHistorySnapshot(updated);
      appendTelemetry('item classified', { itemId: item.id, itemName: item.itemName, dataType: item.dataType });
      appendConsoleLog({
        source: 'SHADOW',
        dataType: item.dataType,
        status: 'Classified',
        message: `Item ${item.itemName} classified as ${updated.detectedType}.`,
        destination: updated.suggestedDestination,
      });
      return;
    }

    if (action === 'STAGE') {
      const updated = { ...item, status: 'Staged' as const, reviewNeeded: true, requiresJasonReview: true, lastUpdatedAt: nowIso() };
      applyQueueUpdate(itemId, () => updated);
      saveHistorySnapshot(updated);
      appendTelemetry('item staged', { itemId: item.id, itemName: item.itemName });
      appendConsoleLog({
        source: 'SHADOW',
        dataType: item.dataType,
        status: 'Staged',
        message: `Item ${item.itemName} staged and awaiting Jason/Admin review.`,
        destination: updated.suggestedDestination,
      });
      return;
    }

    if (action === 'APPROVE' || action === 'REJECT') {
      const backendAction = action === 'APPROVE' ? 'approve' : 'reject';
      await processReviewAction(item, backendAction);
      appendTelemetry(action === 'APPROVE' ? 'item approved' : 'item rejected', { itemId: item.id, itemName: item.itemName });
      appendConsoleLog({
        source: 'Admin',
        dataType: item.dataType,
        status: action === 'APPROVE' ? 'Approved' : 'Rejected',
        message:
          action === 'APPROVE'
            ? `Backend approval recorded for intake case ${item.intakeCaseId}.`
            : `Backend rejection recorded for intake case ${item.intakeCaseId}.`,
        destination: item.suggestedDestination,
      });
      return;
    }

    if (item.status !== 'Approved') {
      appendConsoleLog({
        source: 'SHADOW',
        dataType: item.dataType,
        status: 'Blocked',
        message: `Import blocked for ${item.itemName}. Item requires Jason/Admin approval first.`,
        destination: item.suggestedDestination,
      });
      return;
    }

    const promotePayload = await processPromotion(item);
    if (!promotePayload) {
      return;
    }
    appendTelemetry('item imported', { itemId: item.id, itemName: item.itemName, destination: item.suggestedDestination });
    const promotedAthleteMessage = promotePayload.athlete_id ? ` for athlete ${promotePayload.athlete_id}` : '';
    appendConsoleLog({
      source: 'SHADOW',
      dataType: item.dataType,
      status: 'Imported',
      message: `Case ${item.intakeCaseId} promoted to domain records${promotedAthleteMessage}.`,
      destination: item.suggestedDestination,
    });
  }

  function handleCommandSubmit(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    const submitted = commandInput.trim().toLowerCase();
    if (!submitted) {
      return;
    }

    appendTelemetry('command submitted', { command: submitted });
    appendConsoleLog({
      source: 'Admin',
      dataType: 'Command',
      status: 'Submitted',
      message: `Command received: ${submitted}`,
      destination: 'SHADOW Local State',
    });

    if (submitted === 'status') {
      appendConsoleLog({
        source: 'SHADOW',
        dataType: 'System',
        status: 'Status',
        message: `Queue=${pendingQueue.length} | History=${importHistory.length} | Selected=${selectedItem ? selectedItem.itemName : 'None'}`,
        destination: 'SHADOW Local State',
      });
    } else if (submitted === 'list') {
      appendConsoleLog({
        source: 'SHADOW',
        dataType: 'System',
        status: 'List',
        message:
          pendingQueue.length === 0
            ? 'No pending intake items in queue.'
            : `Pending items: ${pendingQueue.map((item) => item.itemName).join(' | ')}`,
        destination: 'SHADOW Local State',
      });
    } else if (submitted === 'clear') {
      setConsoleLogs([
        {
          id: newId(),
          timestamp: nowIso(),
          source: 'SHADOW',
          dataType: 'System',
          status: 'Cleared',
          message: 'Console log cleared by admin command.',
          destination: 'SHADOW Local State',
        },
      ]);
    } else if (submitted === 'summarize' || submitted === 'merge') {
      appendConsoleLog({
        source: 'SHADOW',
        dataType: 'System',
        status: 'Summary',
        message: `Intake summary generated. Pending=${pendingQueue.length}; awaiting staged approvals before import.`,
        destination: 'Admin Hub',
      });
    } else if (submitted === 'classify' || submitted === 'stage' || submitted === 'approve' || submitted === 'reject') {
      if (!selectedItem) {
        appendConsoleLog({
          source: 'SHADOW',
          dataType: 'Command',
          status: 'No Target',
          message: `Command ${submitted} requires a selected queue item (use VIEW).`,
          destination: 'SHADOW Local State',
        });
      } else {
        const action = submitted.toUpperCase() as 'CLASSIFY' | 'STAGE' | 'APPROVE' | 'REJECT';
        void handleItemAction(selectedItem.id, action);
      }
    } else {
      appendConsoleLog({
        source: 'SHADOW',
        dataType: 'Command',
        status: 'Placeholder',
        message: `Unknown command: ${submitted}. Use merge | status | list | clear | summarize | classify | stage | approve | reject`,
        destination: 'SHADOW Local State',
      });
    }

    setCommandInput('');
  }

  function handleUploadButtonClick() {
    appendTelemetry('file upload clicked', { ui: 'external-sources' });
    fileInputRef.current?.click();
  }

  async function processUploadedPdf(file: File) {
    setUploadError('');

    if (!file.name.toLowerCase().endsWith('.pdf')) {
      setUploadError('Only PDF files are accepted.');
      appendConsoleLog({
        source: 'SHADOW',
        dataType: 'File Intake',
        status: 'Validation Failed',
        message: `Rejected upload ${file.name}. Only PDF files are supported.`,
        destination: 'SHADOW Local State',
      });
      return;
    }

    setIsUploading(true);
    setUploadedFileName(file.name);

    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('hint', 'admin-upload');
      formData.append('document_type', 'general_intake');

      const response = await fetch('/api/pilot/shadow/upload', {
        method: 'POST',
        body: formData,
      });

      const payload = (await response.json()) as ShadowUploadResponse | { error?: string };

      if (!response.ok || !('ok' in payload)) {
        const errorMessage = 'error' in payload && payload.error ? payload.error : 'Ingest request failed';
        throw new Error(errorMessage);
      }

      const destination = toDestination('Admin Hub');
      const detectedType = toDataType('File Intake');
      const now = nowIso();

      const newItem: IntakeItem = {
        id: payload.intake_case_id,
        intakeCaseId: payload.intake_case_id,
        itemName: file.name,
        dataType: 'File Intake',
        source: 'Admin Upload',
        suggestedDestination: destination,
        status: 'Pending',
        reviewNeeded: true,
        requiresJasonReview: true,
        detectedType,
        confidence: 'Medium',
        notes: `Classification=${payload.classification}; Queue=${payload.routed_queue}; DocumentType=${payload.document_type}`,
        destinationRoute: routeForDestination(destination),
        timestamp: now,
        lastUpdatedAt: now,
      };

      setPendingQueue((prev) => [newItem, ...prev.filter((entry) => entry.intakeCaseId !== newItem.intakeCaseId)]);
      setSelectedItemId(newItem.id);
      setLastIngestSummary(payload);

      await refreshBackendQueue();

      appendConsoleLog({
        source: 'SHADOW',
        dataType: 'File Intake',
        status: 'Processed',
        message: `PDF processed and staged as case ${payload.intake_case_id}.`,
        destination,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown upload failure';
      setUploadError(message);
      appendConsoleLog({
        source: 'SHADOW',
        dataType: 'File Intake',
        status: 'Error',
        message: `Upload processing failed: ${message}`,
        destination: 'SHADOW Local State',
      });
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  }

  function handleFileUploadChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) {
      return;
    }
    void processUploadedPdf(file);
  }

  function handleFileDrop(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDragOver(false);
    const file = event.dataTransfer.files?.[0];
    if (!file) {
      return;
    }
    void processUploadedPdf(file);
  }

  function handleQuickAdd(dataType: DataType, source: string, destination: IntakeDestination, route: string) {
    const newItem = createMockIntakeItem(dataType, source, destination, route);
    setPendingQueue((prev) => [newItem, ...prev]);
    setSelectedItemId(newItem.id);
    appendTelemetry('quick add created', { dataType, source, destination });
    appendConsoleLog({
      source,
      dataType,
      status: 'Pending',
      message: `Quick-add intake created for ${dataType}.`,
      destination,
    });
  }

  function updateSelectedItem(fields: Partial<Pick<IntakeItem, 'detectedType' | 'suggestedDestination' | 'confidence' | 'requiresJasonReview' | 'notes' | 'destinationRoute'>>) {
    if (!selectedItemId) {
      return;
    }

    applyQueueUpdate(selectedItemId, (item) => {
      const nextDestination = fields.suggestedDestination ?? item.suggestedDestination;
      return {
        ...item,
        ...fields,
        reviewNeeded: fields.requiresJasonReview ?? item.requiresJasonReview,
        destinationRoute: fields.destinationRoute ?? routeForDestination(nextDestination),
        lastUpdatedAt: nowIso(),
      };
    });
  }

  useEffect(() => {
    function onGlobalKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const tagName = target?.tagName;
      const isTypingElement = tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT';
      if (isTypingElement) {
        return;
      }

      const key = event.key.toLowerCase();
      const runAction = (action: 'CLASSIFY' | 'STAGE' | 'APPROVE' | 'REJECT' | 'IMPORT') => {
        if (!selectedItemId) {
          return;
        }
        void handleItemActionRef.current(selectedItemId, action);
      };

      if (key === 'c') {
        event.preventDefault();
        runAction('CLASSIFY');
      } else if (key === 's') {
        event.preventDefault();
        runAction('STAGE');
      } else if (key === 'a') {
        event.preventDefault();
        runAction('APPROVE');
      } else if (key === 'r') {
        event.preventDefault();
        runAction('REJECT');
      } else if (key === 'i') {
        event.preventDefault();
        runAction('IMPORT');
      } else if (key === 'v' && selectedItemId) {
        event.preventDefault();
        void handleItemActionRef.current(selectedItemId, 'VIEW');
      }
    }

    window.addEventListener('keydown', onGlobalKeyDown);
    return () => window.removeEventListener('keydown', onGlobalKeyDown);
  }, [selectedItemId]);

  const filteredSortedQueue = useMemo(() => {
    const filtered = pendingQueue.filter((item) => queueFilterStatus === 'ALL' || item.status === queueFilterStatus);

    return [...filtered].sort((a, b) => {
      if (queueSort === 'oldest') {
        return new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
      }
      if (queueSort === 'status') {
        return a.status.localeCompare(b.status) || new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
      }
      return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
    });
  }, [pendingQueue, queueFilterStatus, queueSort]);

  const filteredSortedHistory = useMemo(() => {
    const filtered = importHistory.filter((item) => historyFilterStatus === 'ALL' || item.status === historyFilterStatus);

    return [...filtered].sort((a, b) => {
      if (historySort === 'oldest') {
        return new Date(a.lastUpdatedAt).getTime() - new Date(b.lastUpdatedAt).getTime();
      }
      return new Date(b.lastUpdatedAt).getTime() - new Date(a.lastUpdatedAt).getTime();
    });
  }, [importHistory, historyFilterStatus, historySort]);

  const queueCounts = useMemo(() => {
    return {
      pending: pendingQueue.filter((item) => item.status === 'Pending').length,
      classified: pendingQueue.filter((item) => item.status === 'Classified').length,
      staged: pendingQueue.filter((item) => item.status === 'Staged').length,
      approved: pendingQueue.filter((item) => item.status === 'Approved').length,
    };
  }, [pendingQueue]);

  const commandHints = ['merge', 'status', 'list', 'clear', 'summarize', 'classify', 'stage', 'approve', 'reject'];

  return (
    <RoleStandaloneView roleLabel="SHADOW Admin Console" routeLabel="/admin/shadow" allowedRoles={['admin']} showShellHeader={false}>
      <main className="grid gap-6 xl:grid-cols-[1.25fr_0.95fr]">
        <section className="space-y-6 border-4 border-[#8b4444] bg-[#0a0a0a]/70 p-6">
          <div className="mb-6 border-b border-[#8b4444]/20 pb-4">
            <p className="text-xs font-mono uppercase tracking-[0.2em] text-[#d4a574]">AI/ML Telemetry Scout</p>
            <h2 className="mt-2 text-3xl font-black text-[#e8d7c6]">SHADOW Data Intake + Command Console</h2>
            <p className="mt-2 text-[16px] leading-7 text-[#d4a574]/85">
              Import, classify, stage, and review external data before it enters the PPBF system.
            </p>
          </div>

          <section className="border-4 border-[#8b4444] bg-[#0f0f0f] p-4">
            <div className="mb-3 flex flex-wrap gap-2 text-xs font-mono uppercase tracking-[0.14em] text-[#d4a574]/85">
              <span>Pending: {queueCounts.pending}</span>
              <span>Classified: {queueCounts.classified}</span>
              <span>Staged: {queueCounts.staged}</span>
              <span>Approved: {queueCounts.approved}</span>
            </div>
            <div className="max-h-[500px] space-y-3 overflow-y-auto pr-1">
              {consoleLogs.map((log) => (
                <article key={log.id} className="border-2 border-[#8b4444]/70 bg-[#161616] p-4 font-mono text-[14px] leading-6 text-[#e8d7c6]">
                  <p className="text-[#d4a574]">[{log.timestamp}]</p>
                  <p>SOURCE: {log.source}</p>
                  <p>TYPE: {log.dataType}</p>
                  <p>STATUS: {log.status}</p>
                  <p>MESSAGE: {log.message}</p>
                  <p>DESTINATION: {log.destination ?? 'Unknown'}</p>
                </article>
              ))}
              <div ref={logsEndRef} />
            </div>
          </section>

          <section className="border-4 border-[#8b4444] bg-[#101010] p-4">
            <p className="mb-3 text-[16px] font-semibold text-[#e8d7c6]">Command Bar</p>
            <div className="mb-3 flex flex-wrap gap-2">
              {commandHints.map((hint) => (
                <button
                  key={hint}
                  type="button"
                  onClick={() => setCommandInput(hint)}
                  className="h-11 border border-[#5a2a2a] bg-[#1d1010] px-3 font-mono text-[13px] text-[#d4a574] transition hover:border-[#d4a574] hover:text-[#f0dfce]"
                >
                  {hint}
                </button>
              ))}
            </div>
            <p className="mb-3 font-mono text-[12px] text-[#d4a574]/80">
              Shortcuts: C classify, S stage, A approve, R reject, I import on selected item.
            </p>
            <form onSubmit={handleCommandSubmit} className="flex flex-wrap gap-3">
              <input
                type="text"
                value={commandInput}
                onChange={(e) => setCommandInput(e.target.value)}
                onKeyDown={(event) => {
                  if (event.ctrlKey && event.key === 'Enter') {
                    event.preventDefault();
                    const form = event.currentTarget.form;
                    if (form) {
                      form.requestSubmit();
                    }
                  }
                }}
                placeholder="merge | status | list | clear | summarize | classify | stage | approve | reject"
                className="h-11 min-w-[280px] flex-1 border-2 border-[#8b4444] bg-[#1a1a1a] px-4 font-mono text-[15px] text-[#e8d7c6] placeholder-[#d4a574] outline-none transition focus:border-[#d4a574]"
              />
              <button
                type="submit"
                className="h-11 border-2 border-[#8b4444] bg-[#4a2020] px-6 font-mono text-[14px] font-bold text-[#e8d7c6] transition hover:border-[#d4a574] hover:bg-[#5a3030]"
              >
                Submit Command
              </button>
            </form>
          </section>

          <section className="border-4 border-[#8b4444] bg-[#101010] p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h3 className="text-[18px] font-black text-[#e8d7c6]">PENDING IMPORT QUEUE</h3>
              <p className="font-mono text-[13px] uppercase tracking-[0.1em] text-[#d4a574]">Backed by pilot intake review queue</p>
            </div>

            <div className="mb-4 grid gap-2 md:grid-cols-2">
              <label className="text-[13px] text-[#d4a574]">
                <span className="mb-1 block font-mono uppercase">Filter Status</span>
                <select
                  value={queueFilterStatus}
                  onChange={(event) => setQueueFilterStatus(event.target.value as 'ALL' | IntakeStatus)}
                  className="h-11 w-full border-2 border-[#8b4444] bg-[#141414] px-3 text-[14px] text-[#e8d7c6]"
                >
                  <option value="ALL">ALL</option>
                  <option value="Pending">Pending</option>
                  <option value="Classified">Classified</option>
                  <option value="Staged">Staged</option>
                  <option value="Approved">Approved</option>
                  <option value="Rejected">Rejected</option>
                  <option value="Imported">Imported</option>
                </select>
              </label>
              <label className="text-[13px] text-[#d4a574]">
                <span className="mb-1 block font-mono uppercase">Sort</span>
                <select
                  value={queueSort}
                  onChange={(event) => setQueueSort(event.target.value as QueueSort)}
                  className="h-11 w-full border-2 border-[#8b4444] bg-[#141414] px-3 text-[14px] text-[#e8d7c6]"
                >
                  <option value="newest">Newest First</option>
                  <option value="oldest">Oldest First</option>
                  <option value="status">Status A-Z</option>
                </select>
              </label>
            </div>

            {filteredSortedQueue.length === 0 ? (
              <p className="text-[16px] text-[#d4a574]/80">No pending intake items. Use Upload File or Quick Add to create staging entries.</p>
            ) : (
              <div className="space-y-3">
                {filteredSortedQueue.map((item) => (
                  <article
                    key={item.id}
                    className={`border-2 p-4 ${selectedItemId === item.id ? 'border-[#d4a574] bg-[#1d1111]' : 'border-[#8b4444]/70 bg-[#151515]'}`}
                  >
                    <div className="grid gap-2 text-[14px] text-[#e8d7c6] md:grid-cols-2">
                      <p><span className="font-semibold text-[#d4a574]">Item Name:</span> {item.itemName}</p>
                      <p><span className="font-semibold text-[#d4a574]">Data Type:</span> {item.dataType}</p>
                      <p><span className="font-semibold text-[#d4a574]">Source:</span> {item.source}</p>
                      <p><span className="font-semibold text-[#d4a574]">Suggested Destination:</span> {item.suggestedDestination}</p>
                      <p>
                        <span className="font-semibold text-[#d4a574]">Status:</span>{' '}
                        <span className={`inline-flex border px-2 py-0.5 font-mono text-[12px] ${statusChipClasses(item.status)}`}>{item.status}</span>
                      </p>
                      <p><span className="font-semibold text-[#d4a574]">Review Needed:</span> {item.reviewNeeded ? 'Yes' : 'No'}</p>
                      <p className="md:col-span-2"><span className="font-semibold text-[#d4a574]">Timestamp:</span> {item.timestamp}</p>
                    </div>

                    <div className="mt-3 flex flex-wrap gap-2">
                      {(['VIEW', 'CLASSIFY', 'STAGE', 'APPROVE', 'REJECT', 'IMPORT'] as const).map((action) => (
                        <button
                          key={action}
                          type="button"
                          onClick={() => void handleItemAction(item.id, action)}
                          disabled={action === 'IMPORT' && item.status !== 'Approved'}
                          className="h-11 border-2 border-[#8b4444] bg-[#2a1414] px-3 text-[13px] font-bold text-[#e8d7c6] transition hover:border-[#d4a574] disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          {action}
                        </button>
                      ))}
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>
        </section>

        <aside className="space-y-4">
          <section className="border-4 border-[#d4a574] bg-[#0a0a0a]/70 p-4">
            <p className="text-xs font-mono uppercase tracking-[0.2em] text-[#d4a574]">Data Intake Sources</p>
            <h3 className="mt-2 text-xl font-black text-[#e8d7c6]">External Sources</h3>

            <div
              className={`mt-4 space-y-2 rounded border-2 border-dashed p-3 transition ${
                isDragOver ? 'border-[#e8d7c6] bg-[#3a2a1a]' : 'border-[#8b5a2b] bg-[#1a120a]'
              }`}
              onDragOver={(event) => {
                event.preventDefault();
                setIsDragOver(true);
              }}
              onDragLeave={() => setIsDragOver(false)}
              onDrop={handleFileDrop}
            >
              <p className="text-[12px] font-mono uppercase tracking-[0.08em] text-[#d4a574]">
                Drop PDF here or use the upload button
              </p>
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf,application/pdf"
                onChange={handleFileUploadChange}
                className="hidden"
              />
              <button
                type="button"
                onClick={handleUploadButtonClick}
                disabled={isUploading}
                className="h-11 w-full border-2 border-[#d4a574] bg-[#2a1a0a] px-3 text-[14px] font-mono text-[#d4a574] transition hover:border-[#e8d7c6] hover:bg-[#3a2a1a] hover:text-[#e8d7c6]"
              >
                {isUploading ? 'Processing PDF...' : 'Upload PDF'}
              </button>
              {uploadedFileName && <p className="text-[14px] text-[#d4a574]/80">Last staged file: {uploadedFileName}</p>}
              {uploadError && <p className="text-[13px] text-[#f2c3c3]">{uploadError}</p>}
              {lastIngestSummary && (
                <div className="border border-[#8b5a2b] bg-[#21160d] p-2 text-[12px] text-[#e8d7c6]">
                  <p>Intake Case: {lastIngestSummary.intake_case_id}</p>
                  <p>Intake Document: {lastIngestSummary.intake_document_id}</p>
                  <p>Classification: {lastIngestSummary.classification}</p>
                  <p>Queue: {lastIngestSummary.routed_queue}</p>
                  <p>Review Status: {lastIngestSummary.review_status}</p>
                </div>
              )}
            </div>

            <div className="mt-4 border-t border-[#d4a574]/20 pt-3">
              <p className="text-[14px] font-mono text-[#d4a574]/80">Quick Add:</p>
              <div className="mt-2 grid grid-cols-2 gap-2">
                {QUICK_ADD_OPTIONS.map((option) => (
                  <button
                    key={option.label}
                    type="button"
                    onClick={() => handleQuickAdd(option.label, option.source, option.destination, option.route)}
                    className="h-11 border-2 border-[#d4a574] bg-[#2a1a0a] px-2 text-[12px] text-[#d4a574] transition hover:border-[#e8d7c6] hover:bg-[#3a2a1a]"
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
          </section>

          <section className="border-4 border-[#8b4444] bg-[#0a0a0a]/70 p-4">
            <h3 className="text-xl font-black text-[#e8d7c6]">Classification Panel</h3>
            {!selectedItem ? (
              <p className="mt-3 text-[16px] text-[#d4a574]/80">Select an intake item via VIEW to classify and route it.</p>
            ) : (
              <div className="mt-3 space-y-3 text-[14px] text-[#e8d7c6]">
                <p className="font-semibold text-[#d4a574]">Selected: {selectedItem.itemName}</p>
                <p className={`inline-flex border px-2 py-1 font-mono text-[12px] ${selectedItem.requiresJasonReview ? 'border-[#8b4444] bg-[#341616] text-[#f0c4c4]' : 'border-[#d4a574] bg-[#2e2a14] text-[#f5e7bf]'}`}>
                  {selectedItem.requiresJasonReview ? 'PENDING JASON REVIEW' : 'APPROVED FOR IMPORT'}
                </p>

                <label className="block">
                  <span className="mb-1 block text-[#d4a574]">Detected Type</span>
                  <select
                    value={selectedItem.detectedType}
                    onChange={(event) => updateSelectedItem({ detectedType: event.target.value as DataType })}
                    className="h-11 w-full border-2 border-[#8b4444] bg-[#141414] px-3 text-[14px]"
                  >
                    {QUICK_ADD_OPTIONS.map((option) => (
                      <option key={option.label} value={option.label}>
                        {option.label}
                      </option>
                    ))}
                    <option value="File Intake">File Intake</option>
                    <option value="System">System</option>
                  </select>
                </label>

                <label className="block">
                  <span className="mb-1 block text-[#d4a574]">Suggested Destination</span>
                  <select
                    value={selectedItem.suggestedDestination}
                    onChange={(event) => {
                      const destination = event.target.value as IntakeDestination;
                      updateSelectedItem({ suggestedDestination: destination, destinationRoute: routeForDestination(destination) });
                    }}
                    className="h-11 w-full border-2 border-[#8b4444] bg-[#141414] px-3 text-[14px]"
                  >
                    {DESTINATION_OPTIONS.map((destination) => (
                      <option key={destination} value={destination}>
                        {destination}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="block">
                  <span className="mb-1 block text-[#d4a574]">Confidence</span>
                  <select
                    value={selectedItem.confidence}
                    onChange={(event) => updateSelectedItem({ confidence: event.target.value as ConfidenceLevel })}
                    className="h-11 w-full border-2 border-[#8b4444] bg-[#141414] px-3 text-[14px]"
                  >
                    <option value="Low">Low</option>
                    <option value="Medium">Medium</option>
                    <option value="High">High</option>
                  </select>
                </label>

                <label className="block">
                  <span className="mb-1 block text-[#d4a574]">Requires Jason Review</span>
                  <select
                    value={selectedItem.requiresJasonReview ? 'Yes' : 'No'}
                    onChange={(event) => updateSelectedItem({ requiresJasonReview: event.target.value === 'Yes' })}
                    className="h-11 w-full border-2 border-[#8b4444] bg-[#141414] px-3 text-[14px]"
                  >
                    <option value="Yes">Yes</option>
                    <option value="No">No</option>
                  </select>
                </label>

                <label className="block">
                  <span className="mb-1 block text-[#d4a574]">Notes</span>
                  <textarea
                    value={selectedItem.notes}
                    onChange={(event) => updateSelectedItem({ notes: event.target.value })}
                    className="min-h-[92px] w-full border-2 border-[#8b4444] bg-[#141414] px-3 py-2 text-[14px]"
                  />
                </label>

                <label className="block">
                  <span className="mb-1 block text-[#d4a574]">Destination Route</span>
                  <input
                    value={selectedItem.destinationRoute}
                    onChange={(event) => updateSelectedItem({ destinationRoute: event.target.value })}
                    className="h-11 w-full border-2 border-[#8b4444] bg-[#141414] px-3 text-[14px]"
                  />
                </label>
              </div>
            )}
          </section>

          <section className="border-4 border-[#8b4444] bg-[#0a0a0a]/70 p-4">
            <button
              type="button"
              onClick={() => setShowHistory((current) => !current)}
              className="h-11 w-full border-2 border-[#8b4444] bg-[#2a1414] text-[14px] font-bold text-[#e8d7c6] transition hover:border-[#d4a574]"
            >
              {showHistory ? 'Hide' : 'Show'} IMPORT HISTORY
            </button>
            {showHistory && (
              <div className="mt-3 space-y-2">
                <div className="grid gap-2 md:grid-cols-2">
                  <label className="text-[13px] text-[#d4a574]">
                    <span className="mb-1 block font-mono uppercase">Filter Status</span>
                    <select
                      value={historyFilterStatus}
                      onChange={(event) => setHistoryFilterStatus(event.target.value as 'ALL' | IntakeStatus)}
                      className="h-11 w-full border-2 border-[#8b4444] bg-[#141414] px-3 text-[14px] text-[#e8d7c6]"
                    >
                      <option value="ALL">ALL</option>
                      <option value="Pending">Pending</option>
                      <option value="Classified">Classified</option>
                      <option value="Staged">Staged</option>
                      <option value="Approved">Approved</option>
                      <option value="Rejected">Rejected</option>
                      <option value="Imported">Imported</option>
                    </select>
                  </label>
                  <label className="text-[13px] text-[#d4a574]">
                    <span className="mb-1 block font-mono uppercase">Sort</span>
                    <select
                      value={historySort}
                      onChange={(event) => setHistorySort(event.target.value as HistorySort)}
                      className="h-11 w-full border-2 border-[#8b4444] bg-[#141414] px-3 text-[14px] text-[#e8d7c6]"
                    >
                      <option value="newest">Newest First</option>
                      <option value="oldest">Oldest First</option>
                    </select>
                  </label>
                </div>
                {filteredSortedHistory.length === 0 ? (
                  <p className="text-[14px] text-[#d4a574]/80">No history entries yet.</p>
                ) : (
                  filteredSortedHistory.map((item) => (
                    <div key={`${item.id}-${item.lastUpdatedAt}`} className="border border-[#8b4444]/60 bg-[#151515] p-3 text-[13px] text-[#e8d7c6]">
                      <p className="font-semibold text-[#d4a574]">{item.itemName}</p>
                      <p>
                        <span className={`inline-flex border px-2 py-0.5 font-mono text-[12px] ${statusChipClasses(item.status)}`}>{item.status}</span>
                        <span className="ml-2">- {item.dataType}</span>
                      </p>
                      <p className="font-mono text-[12px] text-[#d4a574]/80">{item.lastUpdatedAt}</p>
                    </div>
                  ))
                )}
              </div>
            )}
          </section>

          <section className="border-4 border-[#8b4444] bg-[#0a0a0a]/70 p-4">
            <button
              type="button"
              onClick={() => setShowTelemetry((current) => !current)}
              className="h-11 w-full border-2 border-[#8b4444] bg-[#2a1414] text-[14px] font-bold text-[#e8d7c6] transition hover:border-[#d4a574]"
            >
              {showTelemetry ? 'Hide' : 'Show'} local telemetry events
            </button>
            {showTelemetry && (
              <div className="mt-3 max-h-[220px] space-y-2 overflow-y-auto border border-[#8b4444]/60 bg-[#111111] p-2 font-mono text-[12px] text-[#d4a574]">
                {telemetryEvents.length === 0 && <p className="p-2 text-[#d4a574]/75">No telemetry events yet.</p>}
                {telemetryEvents.map((event, index) => (
                  <pre key={`${event.timestamp}-${index}`} className="whitespace-pre-wrap border border-[#502828] bg-[#151515] p-2 text-[#d4a574]">
{JSON.stringify(event, null, 2)}
                  </pre>
                ))}
              </div>
            )}
          </section>

          <div className="flex gap-2 pt-2">
            <Link
              href="/admin"
              className="flex-1 border-2 border-[#8b4444] bg-[#1a1a1a] px-3 py-2 text-center text-[12px] font-mono text-[#d4a574] transition hover:border-[#d4a574] hover:text-[#e8d7c6]"
            >
              Admin Hub
            </Link>
            <Link
              href="/shadow"
              className="flex-1 border-2 border-[#8b4444] bg-[#3a0000] px-3 py-2 text-center text-[12px] font-mono text-[#d4a574] transition hover:border-[#d4a574] hover:bg-[#4a0000]"
            >
              SHADOW
            </Link>
          </div>
        </aside>
      </main>
    </RoleStandaloneView>
  );
}
