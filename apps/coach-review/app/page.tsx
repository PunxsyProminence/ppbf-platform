'use client';
import React, { useState } from 'react';
import { runSafetyGate } from '@packages/execution/safetyGate';
import { sendNotification, NOTIFICATION_TYPES } from '@packages/execution/notificationService';
import { logToContinuityLedger, logSafetyEvent } from '@packages/execution/loggingService';

interface Session {
  id: number;
  participant: string;
  participantType: string;
  date: string;
  status: string;
  safetyFlags: string[];
}

export default function CoachReviewQueue() {
  const [sessions, setSessions] = useState<Session[]>([
    { id: 1, participant: "Alex Rivera", participantType: "Youth", date: "2026-06-17", status: "Pending Review", safetyFlags: [] },
    { id: 2, participant: "Jordan Lee", participantType: "AF_SPECOPS", date: "2026-06-16", status: "Pending Review", safetyFlags: ["High RPE"] },
  ]);

  const handleDecision = (session: Session, decision: string) => {
    const safety = runSafetyGate(
      decision.toLowerCase().includes('progress') ? 'progress' : 'pause',
      session.participantType,
      false,
      decision.toLowerCase().includes('sparring')
    );

    if (!safety.allowed) {
      logSafetyEvent(`Blocked decision: ${decision}`, `sess-${session.id}`, 'high');
      alert(`SAFETY GATE BLOCKED\n\n${safety.reason}\n\nRequires Jason approval.`);
      return;
    }

    alert(`Decision recorded: ${decision}\n\nSafety Gate passed. Logged to Continuity Ledger.`);

    // Send notification via the new service
    sendNotification(
      NOTIFICATION_TYPES.COACH_REVIEW,
      'coach@ppbf.org',
      `Review decision for ${session.participant}: ${decision}`
    );

    logToContinuityLedger('COACH_DECISION', { decision, participant: session.participant }, 'Coach');
    
    // Update local state (in production this would call Supabase + trigger promotion log)
    setSessions(prev => prev.map(s => 
      s.id === session.id ? { ...s, status: decision } : s
    ));
  };

  return (
    <div style={{ padding: '40px', maxWidth: '900px', margin: '0 auto' }}>
      <h1>PPBF Coach Review Queue</h1>
      <p><strong>Safety Gate Matrix + Jason Approval Workflow Active</strong></p>
      <p style={{ color: '#c00' }}>All production decisions require explicit governance promotion.</p>

      {sessions.map(session => (
        <div key={session.id} style={{ border: '1px solid #ddd', padding: '24px', margin: '20px 0', borderRadius: '8px' }}>
          <h3>{session.participant} ({session.participantType}) — {session.date}</h3>
          <p>Status: <strong>{session.status}</strong></p>
          
          <div style={{ marginTop: '16px', display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
            <button onClick={() => handleDecision(session, 'Approve Progress')} style={{ background: '#22c55e', color: 'white', padding: '10px 20px', border: 'none', borderRadius: '6px' }}>
              Approve Progress
            </button>
            <button onClick={() => handleDecision(session, 'Require Adjustments')} style={{ background: '#eab308', color: 'white', padding: '10px 20px', border: 'none', borderRadius: '6px' }}>
              Require Adjustments
            </button>
            <button onClick={() => handleDecision(session, 'Safety Pause')} style={{ background: '#ef4444', color: 'white', padding: '10px 20px', border: 'none', borderRadius: '6px' }}>
              Safety Pause
            </button>
            <button onClick={() => handleDecision(session, 'Request Sparring Clearance')} style={{ background: '#6b7280', color: 'white', padding: '10px 20px', border: 'none', borderRadius: '6px' }}>
              Request Sparring Clearance
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
