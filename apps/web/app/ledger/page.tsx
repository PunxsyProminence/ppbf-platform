'use client';
import React, { useState } from 'react';
import { ledger, DecisionLogEntry } from '@packages/continuity/ledger';

export default function ContinuityLedgerDashboard() {
  const [logs, setLogs] = useState<DecisionLogEntry[]>(ledger.getLogs());
  const [duplicates, setDuplicates] = useState<DecisionLogEntry[]>([]);

  const addTestDecision = (type: DecisionLogEntry['decisionType']) => {
    const entry = ledger.recordDecision({
      decisionType: type,
      actor: 'coach-demo',
      targetId: 'sess-001',
      rationale: 'Test decision from web portal (governed)',
      governanceFlag: false,
    });
    setLogs(ledger.getLogs());
  };

  const scanDuplicates = () => {
    setDuplicates(ledger.findDuplicates());
  };

  const promote = (id: string) => {
    const res = ledger.requestPromotion(id, prompt('Enter approver (must be Jason):') || '');
    alert('Promotion result: ' + res);
    setLogs(ledger.getLogs());
  };

  return (
    <div style={{ padding: 40 }}>
      <h1>PPBF Build Continuity Ledger</h1>
      <p>Capability #22 — Append-only. Jason approval required for promotions. Duplicate scanner active.</p>

      <div style={{ marginBottom: 16 }}>
        <button onClick={() => addTestDecision('APPROVE')}>Record APPROVE</button>
        <button onClick={() => addTestDecision('SAFETY_PAUSE')}>Record SAFETY_PAUSE</button>
        <button onClick={() => addTestDecision('PROMOTION')}>Record PROMOTION</button>
        <button onClick={scanDuplicates} className="secondary" style={{ marginLeft: 8 }}>Scan Duplicates</button>
      </div>

      <div className="card">
        <h2>Decision Logs ({logs.length})</h2>
        <table className="data-table">
          <thead><tr><th>Time</th><th>Type</th><th>Actor</th><th>Target</th><th>Rationale</th><th>Action</th></tr></thead>
          <tbody>
            {logs.length === 0 && <tr><td colSpan={6}>No logs yet. Record a test decision.</td></tr>}
            {logs.map(log => (
              <tr key={log.id}>
                <td>{new Date(log.timestamp).toLocaleTimeString()}</td>
                <td>{log.decisionType}</td>
                <td>{log.actor}</td>
                <td>{log.targetId}</td>
                <td>{log.rationale}</td>
                <td><button onClick={() => promote(log.id)}>Promote (Jason only)</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {duplicates.length > 0 && (
        <div className="card" style={{ borderColor: '#e53e3e' }}>
          <h2>⚠️ Duplicates Detected</h2>
          <pre>{JSON.stringify(duplicates, null, 2)}</pre>
        </div>
      )}

      <a href="/">← Back</a>
    </div>
  );
}
