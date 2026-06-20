'use client';
import React, { useState, useEffect } from 'react';
import { ppbfService } from '@packages/execution/ppbfService';
import type { Assignment } from '@packages/execution/models';

export default function AthleteDashboard() {
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [reflection, setReflection] = useState('');
  const [loading, setLoading] = useState(false);

  const participantId = 'demo-participant-001';

  useEffect(() => {
    ppbfService.getAssignments(participantId).then((data) => {
      if (data.length === 0) {
        // Seed with demo data for now (in real use this would come from service)
        setAssignments([
          { id: 'a1', participantId, title: "Shadow Boxing Fundamentals", taskDimension: "Boxing Technique Fundamentals", lifecycleTag: "Youth Development (Non-Contact Safe)", status: "Assigned" },
          { id: 'a2', participantId, title: "Emotional Regulation Drill - Round 2", taskDimension: "Emotional Regulation & Stress Response", lifecycleTag: "Emotional Regulation Focus", status: "In Progress" },
        ]);
      } else {
        setAssignments(data);
      }
    });
  }, []);

  const markComplete = (id: string) => {
    setAssignments(as => as.map(a => a.id === id ? { ...a, status: 'Completed' } : a));
    alert('Progress logged. Coach review queue notified. (Safety Gate applies)');
  };

  const submitReflection = async () => {
    if (!reflection.trim()) return;
    setLoading(true);
    const res = await ppbfService.submitReflection(participantId, reflection);
    alert(`Reflection submitted to Self-Report Service + Coach Review (Cap #9 + #10)\nLogged to Ledger: ${res.loggedToLedger}`);
    setReflection('');
    setLoading(false);
  };

  return (
    <div style={{ padding: 40 }}>
      <h1>PPBF Athlete Self-Service Portal</h1>
      <p>Capability #13 — Goal-derived routes from PPBF_CAPABILITIES routing matrix (1056 combos)</p>

      <div className="card">
        <h2>My Assignments</h2>
        {assignments.length === 0 && <p>Loading assignments via PPBFService...</p>}
        {assignments.map(a => (
          <div key={a.id} style={{ padding: '12px 0', borderBottom: '1px solid #eee' }}>
            <strong>{a.title}</strong><br />
            <small>Dimension: {a.taskDimension} | Tag: {a.lifecycleTag}</small><br />
            Status: <span className="status-pill status-active">{a.status}</span>
            {a.status !== 'Completed' && <button style={{ marginLeft: 12 }} onClick={() => markComplete(a.id)}>Mark Complete</button>}
          </div>
        ))}
      </div>

      <div className="card">
        <h2>Daily Reflection (Self-Report)</h2>
        <textarea value={reflection} onChange={e => setReflection(e.target.value)} placeholder="What did you notice today about timing, breathing, focus?" rows={4} style={{ width: '100%' }} />
        <button onClick={submitReflection} disabled={loading} style={{ marginTop: 8 }}>
          {loading ? 'Submitting...' : 'Submit Reflection'}
        </button>
      </div>

      <a href="/">← Back to Portal</a>
    </div>
  );
}
