'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import RoleStandaloneView from '@/components/RoleStandaloneView';

interface ChatMessage {
  id: string;
  type: 'user' | 'system' | 'shadow';
  text: string;
  timestamp: string;
  dataContext?: Record<string, unknown>;
}

interface ImportedDataSet {
  type: 'workout' | 'biometric' | 'coach-note' | 'video' | 'custom';
  label: string;
  data: Record<string, unknown>;
  importedAt: string;
  importSource: string;
}

export default function AdminShadowConsolePage() {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: '0',
      type: 'system',
      text: 'SHADOW Admin Console initialized. Ready to merge external data sources and manage platform state.',
      timestamp: new Date().toISOString(),
    },
  ]);
  const [userInput, setUserInput] = useState('');
  const [dataSets, setDataSets] = useState<ImportedDataSet[]>([]);
  const [uploadedFileName, setUploadedFileName] = useState('');
  const [mergeLog, setMergeLog] = useState<string[]>([]);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Auto-scroll to newest message
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  function addMessage(type: ChatMessage['type'], text: string, dataContext?: Record<string, unknown>) {
    const newMessage: ChatMessage = {
      id: Date.now().toString(),
      type,
      text,
      timestamp: new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      dataContext,
    };
    setMessages((prev) => [...prev, newMessage]);
  }

  function handleSendMessage(e: React.FormEvent) {
    e.preventDefault();
    if (!userInput.trim()) return;

    addMessage('user', userInput);

    // Parse command
    const cmd = userInput.toLowerCase().trim();

    if (cmd.includes('merge')) {
      handleMergeCommand();
    } else if (cmd.includes('status') || cmd.includes('summary')) {
      handleStatusCommand();
    } else if (cmd.includes('list') || cmd.includes('show')) {
      handleListCommand();
    } else if (cmd.includes('clear')) {
      handleClearCommand();
    } else {
      addMessage('shadow', `Acknowledged: "${userInput}". Use commands like "merge", "status", "list", or "clear" to manage data sources.`);
    }

    setUserInput('');
  }

  function handleMergeCommand() {
    if (dataSets.length === 0) {
      addMessage('shadow', 'No data sets imported. Upload external data first using the import panel.');
      return;
    }

    const newLogs = [`Merge initiated at ${new Date().toLocaleTimeString('en-US', { hour12: false })}`];
    let consolidatedRecords = 0;

    dataSets.forEach((ds) => {
      const recordCount = Object.keys(ds.data).length;
      newLogs.push(`✓ Merged ${recordCount} records from ${ds.label} (${ds.importSource})`);
      consolidatedRecords += recordCount;
    });

    newLogs.push(`\nConsolidation complete: ${consolidatedRecords} total records integrated into platform state.`);
    setMergeLog(newLogs);

    addMessage('shadow', `Data merge successful. Consolidated ${consolidatedRecords} records from ${dataSets.length} data source(s). Check merge log panel.`, {
      recordsProcessed: consolidatedRecords,
      sourcesUsed: dataSets.length,
    });
  }

  function handleStatusCommand() {
    const status = `Platform Status:
- Data Sets Imported: ${dataSets.length}
- Chat History: ${messages.length} messages
- Merge Operations: ${mergeLog.length > 0 ? 'Completed' : 'None yet'}
- Ready State: Active`;

    addMessage('shadow', status, { dataSetsCount: dataSets.length, messagesCount: messages.length });
  }

  function handleListCommand() {
    if (dataSets.length === 0) {
      addMessage('shadow', 'No data sets imported yet.');
      return;
    }

    const list = dataSets.map((ds) => `• ${ds.label} (${ds.type}) - ${Object.keys(ds.data).length} records`).join('\n');
    addMessage('shadow', `Imported Data Sets:\n${list}`, { dataSets: dataSets.length });
  }

  function handleClearCommand() {
    setDataSets([]);
    setMergeLog([]);
    addMessage('shadow', 'Data sets and merge logs cleared. Ready for new imports.');
  }

  function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploadedFileName(file.name);

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const content = event.target?.result as string;
        let parsedData: Record<string, unknown>;

        // Try JSON
        try {
          parsedData = JSON.parse(content);
        } catch {
          // Try CSV -> simple object
          const lines = content.split('\n').filter((l) => l.trim());
          parsedData = { records: lines, format: 'csv', line_count: lines.length };
        }

        // Detect type
        let dataType: ImportedDataSet['type'] = 'custom';
        if (
          file.name.toLowerCase().includes('workout') ||
          file.name.toLowerCase().includes('training')
        ) {
          dataType = 'workout';
        } else if (
          file.name.toLowerCase().includes('biometric') ||
          file.name.toLowerCase().includes('sensor')
        ) {
          dataType = 'biometric';
        } else if (
          file.name.toLowerCase().includes('coach') ||
          file.name.toLowerCase().includes('note')
        ) {
          dataType = 'coach-note';
        }

        const newDataSet: ImportedDataSet = {
          type: dataType,
          label: file.name,
          data: parsedData,
          importedAt: new Date().toISOString(),
          importSource: `File upload (${file.type || 'unknown'})`,
        };

        setDataSets((prev) => [...prev, newDataSet]);
        addMessage('shadow', `✓ Imported: ${file.name} (${dataType}). ${Object.keys(parsedData).length} data points loaded.`, {
          fileName: file.name,
          dataType,
        });
      } catch (err) {
        addMessage('shadow', `✗ Import failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
      }
    };

    reader.readAsText(file);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  function handleManualDataEntry(type: string) {
    const sampleData: Record<string, Record<string, unknown>> = {
      workout: { activity: 'Sparring', duration_minutes: 45, intensity: 'High', date: new Date().toISOString() },
      biometric: { heart_rate: 72, sleep_hours: 7.5, soreness_level: 3, date: new Date().toISOString() },
      'coach-note': { observation: 'Technique improvement noted', athlete_id: 'A001', date: new Date().toISOString() },
    };

    const data = sampleData[type] || { sample: 'data' };

    const newDataSet: ImportedDataSet = {
      type: (type as any) || 'custom',
      label: `Manual ${type} entry`,
      data,
      importedAt: new Date().toISOString(),
      importSource: 'Manual admin entry',
    };

    setDataSets((prev) => [...prev, newDataSet]);
    addMessage('shadow', `✓ Added sample ${type} data set. Edit in merge panel or import external file.`, { dataType: type });
  }

  return (
    <RoleStandaloneView roleLabel="SHADOW Admin Console" routeLabel="/admin/shadow" allowedRoles={['admin']}>
      <main className="grid gap-6 lg:grid-cols-[1fr_380px]">
        {/* Chat Interface */}
        <section className="rounded-3xl border border-red-500/30 bg-[#0a0609]/70 p-6 shadow-2xl shadow-red-950/20">
          <div className="mb-6 border-b border-red-500/20 pb-4">
            <p className="text-xs font-mono uppercase tracking-[0.2em] text-red-400">AI/ML Telemetry Scout</p>
            <h2 className="mt-2 text-2xl font-black text-red-50">SHADOW Conversation Hub</h2>
            <p className="mt-1 text-sm text-red-200/70">Data merge, platform intelligence, external source consolidation</p>
          </div>

          {/* Messages */}
          <div className="mb-6 max-h-[500px] space-y-4 overflow-y-auto rounded-2xl bg-[#0f0b0c] p-4">
            {messages.map((msg) => (
              <div
                key={msg.id}
                className={`flex gap-3 ${msg.type === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  className={`max-w-xs rounded-2xl px-4 py-3 ${
                    msg.type === 'user'
                      ? 'border border-red-500/50 bg-red-500/10 text-red-100'
                      : msg.type === 'system'
                        ? 'border border-slate-700 bg-slate-900/60 text-slate-200'
                        : 'border border-red-400/40 bg-red-950/40 text-red-50'
                  }`}
                >
                  <p className="text-sm leading-6">{msg.text}</p>
                  <p className="mt-1 text-[10px] opacity-60">{msg.timestamp}</p>
                </div>
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
          <form onSubmit={handleSendMessage} className="flex gap-3">
            <input
              type="text"
              value={userInput}
              onChange={(e) => setUserInput(e.target.value)}
              placeholder="merge | status | list | clear ..."
              className="flex-1 rounded-2xl border border-red-500/30 bg-red-950/20 px-4 py-3 text-sm text-red-50 placeholder-red-400/50 outline-none transition focus:border-red-400/50 focus:bg-red-950/30"
            />
            <button
              type="submit"
              className="rounded-2xl border border-red-500/50 bg-red-500/20 px-6 py-3 text-sm font-mono font-bold text-red-200 transition hover:border-red-400/70 hover:bg-red-500/30 hover:text-red-100"
            >
              Send
            </button>
          </form>
        </section>

        {/* Data Import & Merge Panel */}
        <aside className="space-y-4">
          {/* Import Section */}
          <section className="rounded-3xl border border-amber-500/30 bg-[#0b0a09]/70 p-4">
            <p className="text-xs font-mono uppercase tracking-[0.2em] text-amber-400">Data Import</p>
            <h3 className="mt-2 text-lg font-black text-amber-50">External Sources</h3>

            <div className="mt-4 space-y-2">
              <input
                ref={fileInputRef}
                type="file"
                accept=".json,.csv,.txt"
                onChange={handleFileUpload}
                className="hidden"
              />
              <button
                onClick={() => fileInputRef.current?.click()}
                className="w-full rounded-2xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm font-mono text-amber-200 transition hover:border-amber-400/60 hover:bg-amber-500/20 hover:text-amber-100"
              >
                📁 Upload File
              </button>
              {uploadedFileName && (
                <p className="text-[11px] text-amber-300/70">Last: {uploadedFileName}</p>
              )}
            </div>

            <div className="mt-4 border-t border-amber-500/20 pt-3">
              <p className="text-[11px] font-mono text-amber-300/60">Quick Add:</p>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <button
                  onClick={() => handleManualDataEntry('workout')}
                  className="rounded-xl border border-amber-500/30 bg-amber-950/40 px-2 py-1 text-[11px] text-amber-200 transition hover:border-amber-400/50 hover:bg-amber-500/10"
                >
                  Workout
                </button>
                <button
                  onClick={() => handleManualDataEntry('biometric')}
                  className="rounded-xl border border-amber-500/30 bg-amber-950/40 px-2 py-1 text-[11px] text-amber-200 transition hover:border-amber-400/50 hover:bg-amber-500/10"
                >
                  Biometric
                </button>
                <button
                  onClick={() => handleManualDataEntry('coach-note')}
                  className="rounded-xl border border-amber-500/30 bg-amber-950/40 px-2 py-1 text-[11px] text-amber-200 transition hover:border-amber-400/50 hover:bg-amber-500/10"
                >
                  Coach Note
                </button>
                <button
                  onClick={() => handleManualDataEntry('video')}
                  className="rounded-xl border border-amber-500/30 bg-amber-950/40 px-2 py-1 text-[11px] text-amber-200 transition hover:border-amber-400/50 hover:bg-amber-500/10"
                >
                  Video
                </button>
              </div>
            </div>
          </section>

          {/* Imported Data */}
          {dataSets.length > 0 && (
            <section className="rounded-3xl border border-cyan-500/30 bg-[#09090f]/70 p-4">
              <p className="text-xs font-mono uppercase tracking-[0.2em] text-cyan-400">Data Sets</p>
              <div className="mt-3 space-y-2">
                {dataSets.map((ds, idx) => (
                  <div key={idx} className="rounded-2xl border border-cyan-500/30 bg-cyan-950/20 p-2">
                    <p className="text-xs font-mono text-cyan-300">{ds.label}</p>
                    <p className="text-[10px] text-cyan-400/70">
                      {ds.type} • {Object.keys(ds.data).length} records
                    </p>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Merge Log */}
          {mergeLog.length > 0 && (
            <section className="rounded-3xl border border-green-500/30 bg-[#050a06]/70 p-4">
              <p className="text-xs font-mono uppercase tracking-[0.2em] text-green-400">Merge Log</p>
              <div className="mt-3 space-y-1 font-mono text-[10px]">
                {mergeLog.map((log, idx) => (
                  <p key={idx} className="text-green-300/80">
                    {log}
                  </p>
                ))}
              </div>
            </section>
          )}

          {/* Nav */}
          <div className="flex gap-2 pt-2">
            <Link
              href="/admin"
              className="flex-1 rounded-2xl border border-slate-700 bg-slate-900 px-3 py-2 text-center text-[11px] font-mono text-slate-300 transition hover:border-slate-500 hover:text-slate-100"
            >
              Admin Hub
            </Link>
            <Link
              href="/shadow"
              className="flex-1 rounded-2xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-center text-[11px] font-mono text-red-300 transition hover:border-red-400/50 hover:bg-red-500/20"
            >
              SHADOW
            </Link>
          </div>
        </aside>
      </main>
    </RoleStandaloneView>
  );
}
