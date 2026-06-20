'use client';
import React, { useState } from 'react';
import { generateImpactReport, exportReportToPDF, ImpactReport } from '@packages/portals/reporting/impactReport';
import { generateAdvancedAnalytics } from '@packages/intelligence/advancedAnalytics';
import { generateMonthlyReport } from '@packages/portals/reporting/reportGenerator';
import { exportParticipantsToCSV, exportSessionsToJSON } from '@packages/execution/exportUtils';
import { logToContinuityLedger } from '@packages/execution/loggingService';

export default function ReportsPage() {
  const [report, setReport] = useState<ImpactReport | null>(null);
  const [analytics, setAnalytics] = useState<any>(null);

  const handleGenerate = () => {
    const data = { period: 'Q2 2026', totalParticipants: 52, sessionsCompleted: 341 };
    const r = generateImpactReport(data);
    logToContinuityLedger('REPORT_GENERATED', { type: 'impact', period: data.period });
    setReport(r);
  };

  const handleAdvanced = () => {
    // Demo data aligned with existing models
    const demoSessions = [
      { intensityRpe: 6, safetyFlags: [] },
      { intensityRpe: 7, safetyFlags: [] },
      { intensityRpe: 5, safetyFlags: ['minor'] },
    ];
    const demoParticipants = [{ id: 1 }, { id: 2 }];
    const a = generateAdvancedAnalytics(demoSessions, demoParticipants);
    setAnalytics(a);
  };

  const handleMonthly = () => {
    const data = { period: 'Q2 2026', totalParticipants: 52, sessionsCompleted: 341 };
    const r = generateMonthlyReport('June 2026', data);
    setReport(r as any);
  };

  const handleExportCSV = () => {
    const demoParticipants = [
      { id: 'p1', full_name: 'Alex Rivera', participant_type: 'Youth' },
      { id: 'p2', full_name: 'Jordan Lee', participant_type: 'AF_SPECOPS' },
    ];
    const csv = exportParticipantsToCSV(demoParticipants);
    logToContinuityLedger('EXPORT_CSV', {type: 'participants', count: demoParticipants.length});
    alert('CSV Exported (logged):\n' + csv.substring(0, 100) + '...');
    // In real: download or log
  };

  const handleExportJSON = () => {
    const demoSessions = [{ id: 's1', intensity_rpe: 6, safety_flags: [] }];
    const json = exportSessionsToJSON(demoSessions);
    logToContinuityLedger('EXPORT_JSON', {type: 'sessions', count: demoSessions.length});
    alert('JSON Exported (logged):\n' + json);
  };

  const handleExport = () => {
    if (report) {
      const msg = exportReportToPDF(report);
      alert(msg);
    }
  };

  return (
    <div style={{ padding: 40 }}>
      <h1>PPBF Grant / Impact Reporting Engine</h1>
      <p>Capability #16 — Uses feature flags from PPBF_CAPABILITIES.json</p>
      <button onClick={handleGenerate}>Generate Impact Report</button>
      <button onClick={handleAdvanced} style={{ marginLeft: 12 }}>Generate Advanced Analytics</button>
      <button onClick={handleMonthly} style={{ marginLeft: 12 }}>Generate Monthly Report</button>
      <button onClick={handleExportCSV} style={{ marginLeft: 12 }}>Export Participants CSV</button>
      <button onClick={handleExportJSON} style={{ marginLeft: 12 }}>Export Sessions JSON</button>
      {report && (
        <div className="card" style={{ marginTop: 20 }}>
          <h2>Report: {report.period}</h2>
          <ul>
            <li>Total Participants: {report.totalParticipants}</li>
            <li>Sessions Completed: {report.sessionsCompleted}</li>
            <li>Safety Incidents: {report.safetyIncidents}</li>
            <li>Attendance Rate: {report.attendanceRate}%</li>
          </ul>
          <h3>Outcome Summaries</h3>
          <ul>{report.outcomeSummaries.map((o, i) => <li key={i}>{o}</li>)}</ul>
          <button onClick={handleExport} className="secondary">Export to PDF (governed)</button>
        </div>
      )}
      {analytics && (
        <div className="card" style={{ marginTop: 20 }}>
          <h2>Advanced Analytics (Intelligence Layer)</h2>
          <pre>{JSON.stringify(analytics, null, 2)}</pre>
        </div>
      )}
      <a href="/">← Back to Portal Home</a>
    </div>
  );
}
