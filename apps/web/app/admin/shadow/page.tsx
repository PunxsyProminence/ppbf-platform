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

  function handleManualDataEntry(type: ImportedDataSet['type']) {
    const sampleData: Partial<Record<ImportedDataSet['type'], Record<string, unknown>>> = {
      workout: { activity: 'Sparring', duration_minutes: 45, intensity: 'High', date: new Date().toISOString() },
      biometric: { heart_rate: 72, sleep_hours: 7.5, soreness_level: 3, date: new Date().toISOString() },
      'coach-note': { observation: 'Technique improvement noted', athlete_id: 'A001', date: new Date().toISOString() },
    };

    const data = sampleData[type] || { sample: 'data' };

    const newDataSet: ImportedDataSet = {
      type,
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
        <section className="border-4 border-[#8b4444] bg-[#0a0a0a]/70 p-6">
          <div className="mb-6 border-b border-[#8b4444]/20 pb-4">
            <p className="text-xs font-mono uppercase tracking-[0.2em] text-[#d4a574]">AI/ML Telemetry Scout</p>
            <h2 className="mt-2 text-2xl font-black text-[#e8d7c6]">SHADOW Conversation Hub</h2>
            <p className="mt-1 text-sm text-[#d4a574]/70">Data merge, platform intelligence, external source consolidation</p>
          </div>

          {/* Messages */}
          <div className="mb-6 max-h-[500px] space-y-4 overflow-y-auto bg-[#0f0f0f] p-4 border-4 border-[#8b4444]">
            {messages.map((msg) => (
              <div
                key={msg.id}
                className={`flex gap-3 ${msg.type === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  className={`max-w-xs px-4 py-3 border-2 ${
                    msg.type === 'user'
                      ? 'border-[#8b4444] bg-[#5a2a2a] text-[#e8d7c6]'
                      : msg.type === 'system'
                        ? 'border-[#d4a574] bg-[#2a2a2a] text-[#e8d7c6]'
                        : 'border-[#8b4444] bg-[#4a2020] text-[#e8d7c6]'
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
              className="flex-1 border-2 border-[#8b4444] bg-[#1a1a1a] px-4 py-3 text-sm text-[#e8d7c6] placeholder-[#d4a574] outline-none transition focus:border-[#d4a574] focus:bg-[#2a2a2a]"
            />
            <button
              type="submit"
              className="border-2 border-[#8b4444] bg-[#4a2020] px-6 py-3 text-sm font-mono font-bold text-[#e8d7c6] transition hover:border-[#d4a574] hover:bg-[#5a3030] hover:text-[#f5f5f5]"
            >
              Send
            </button>
          </form>
        </section>

        {/* Data Import & Merge Panel */}
        <aside className="space-y-4">
          {/* Import Section */}
          <section className="border-4 border-[#d4a574] bg-[#0a0a0a]/70 p-4">
            <p className="text-xs font-mono uppercase tracking-[0.2em] text-[#d4a574]">Data Import</p>
            <h3 className="mt-2 text-lg font-black text-[#e8d7c6]">External Sources</h3>

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
                className="w-full border-2 border-[#d4a574] bg-[#2a1a0a] px-3 py-2 text-sm font-mono text-[#d4a574] transition hover:border-[#e8d7c6] hover:bg-[#3a2a1a] hover:text-[#e8d7c6]"
              >
                📁 Upload File
              </button>
              {uploadedFileName && (
                <p className="text-[11px] text-[#d4a574]/70">Last: {uploadedFileName}</p>
              )}
            </div>

            <div className="mt-4 border-t border-[#d4a574]/20 pt-3">
              <p className="text-[11px] font-mono text-[#d4a574]/60">Quick Add:</p>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <button
                  onClick={() => handleManualDataEntry('workout')}
                  className="border-2 border-[#d4a574] bg-[#2a1a0a] px-2 py-1 text-[11px] text-[#d4a574] transition hover:border-[#e8d7c6] hover:bg-[#3a2a1a]"
                >
                  Workout
                </button>
                <button
                  onClick={() => handleManualDataEntry('biometric')}
                  className="border-2 border-[#d4a574] bg-[#2a1a0a] px-2 py-1 text-[11px] text-[#d4a574] transition hover:border-[#e8d7c6] hover:bg-[#3a2a1a]"
                >
                  Biometric
                </button>
                <button
                  onClick={() => handleManualDataEntry('coach-note')}
                  className="border-2 border-[#d4a574] bg-[#2a1a0a] px-2 py-1 text-[11px] text-[#d4a574] transition hover:border-[#e8d7c6] hover:bg-[#3a2a1a]"
                >
                  Coach Note
                </button>
                <button
                  onClick={() => handleManualDataEntry('video')}
                  className="border-2 border-[#d4a574] bg-[#2a1a0a] px-2 py-1 text-[11px] text-[#d4a574] transition hover:border-[#e8d7c6] hover:bg-[#3a2a1a]"
                >
                  Video
                </button>
              </div>
            </div>
          </section>

          {/* Imported Data */}
          {dataSets.length > 0 && (
            <section className="border-4 border-[#8b4444] bg-[#0a0a0a]/70 p-4">
              <p className="text-xs font-mono uppercase tracking-[0.2em] text-[#d4a574]">Data Sets</p>
              <div className="mt-3 space-y-2">
                {dataSets.map((ds, idx) => (
                  <div key={idx} className="border-2 border-[#8b4444] bg-[#1a1a1a]/20 p-2">
                    <p className="text-xs font-mono text-[#d4a574]">{ds.label}</p>
                    <p className="text-[10px] text-[#d4a574]/70">
                      {ds.type} • {Object.keys(ds.data).length} records
                    </p>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Merge Log */}
          {mergeLog.length > 0 && (
            <section className="border-4 border-[#8b4444] bg-[#0a0a0a]/70 p-4">
              <p className="text-xs font-mono uppercase tracking-[0.2em] text-[#d4a574]">Merge Log</p>
              <div className="mt-3 space-y-1 font-mono text-[10px]">
                {mergeLog.map((log, idx) => (
                  <p key={idx} className="text-[#d4a574]/80">
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
              className="flex-1 border-2 border-[#8b4444] bg-[#1a1a1a] px-3 py-2 text-center text-[11px] font-mono text-[#d4a574] transition hover:border-[#d4a574] hover:text-[#e8d7c6]"
            >
              Admin Hub
            </Link>
            <Link
              href="/shadow"
              className="flex-1 border-2 border-[#8b4444] bg-[#3a0000] px-3 py-2 text-center text-[11px] font-mono text-[#d4a574] transition hover:border-[#d4a574] hover:bg-[#4a0000]"
            >
              SHADOW
            </Link>
          </div>
        </aside>
      </main>
    </RoleStandaloneView>
  );
}
