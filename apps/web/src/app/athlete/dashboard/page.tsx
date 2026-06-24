'use client';

import { useState } from 'react';
import { stageDataTransaction, TrackType } from '@/utils/gateway';

export default function ComprehensiveAthleteDashboard() {
  const [activeTrack, setActiveTrack] = useState<TrackType>("TRACK_B_MULTIPROGRAM");
  const [reflection, setReflection] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitStatus, setSubmitStatus] = useState('');

  const activeParticipantId = "ATH-9921";
  const corporateStencil = "Punxsy Prominence Boxing and Fitness, Registered Office: 204 PENNSYLVANIA AVE, BIG RUN(PA), PA 15715";

  const executePipelineSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!reflection.trim()) return;

    const crisisKeywords = ["suicide", "depression", "self-harm", "therapy", "diagnose", "crisis", "anxiety"];
    if (crisisKeywords.some(word => reflection.toLowerCase().includes(word))) {
      setSubmitStatus("Submission Rejected: System is programmatically hard-locked against processing clinical psychology requests.");
      return;
    }

    setIsSubmitting(true);
    setSubmitStatus('Packaging transaction frame for staging review...');

    const response = await stageDataTransaction({
      participantId: activeParticipantId,
      trackType: activeTrack,
      status: "Review_Required",
      payloadData: {
        metricType: "ATHLETE_METRIC_SELF_REPORT",
        userReflectionText: reflection,
        timestamp: new Date().toISOString()
      }
    });

    setIsSubmitting(false);
    if (response.status === "STAGED") {
      setSubmitStatus(\Successfully Staged inside Buffer! Transaction ID: \\);
      setReflection('');
    } else {
      setSubmitStatus(\Transit Aborted: \\);
    }
  };

  const handleTaskVerificationRequest = async (taskName: string, dimension: string) => {
    setSubmitStatus(\Filing verification request for: \\);
    const response = await stageDataTransaction({
      participantId: activeParticipantId,
      trackType: activeTrack,
      status: "Needs verification",
      payloadData: {
        metricType: "TASK_COMPLETION_REQUEST",
        completedTaskName: taskName,
        taskDimension: dimension,
        timestamp: new Date().toISOString()
      }
    });

    if (response.status === "STAGED") {
      setSubmitStatus(\Verification packet cached. Transaction ID: \\);
    } else {
      setSubmitStatus(\Verification transit failed: \\);
    }
  };

  return (
    <div style={{ backgroundColor: '#111', color: '#fff', minHeight: '100vh', fontFamily: 'Arial, sans-serif' }}>
      <header style={{ borderBottom: '2px solid #222', padding: '1.5rem', backgroundColor: '#1a1a1a' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <span style={{ fontSize: '0.8rem', letterSpacing: '2px', color: '#777', fontWeight: 'bold' }}>PPBF SYSTEM OPERATIONAL NODE</span>
            <h1 style={{ margin: '0.2rem 0 0 0', color: '#00bc6c', fontSize: '1.8rem' }}>Ecosystem Management Terminal</h1>
          </div>
          <div style={{ textAlign: 'right', fontSize: '0.85rem', color: '#aaa' }}>
            <div><strong>Version:</strong> v21.11-Unified</div>
            <div><strong>Telemetry Check:</strong> Base Active</div>
          </div>
        </div>
      </header>

      <main style={{ maxWidth: '1200px', margin: '0 auto', padding: '2rem', display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '2rem' }}>
        <section>
          <div style={{ backgroundColor: '#1a1a1a', padding: '1.5rem', borderRadius: '6px', marginBottom: '1.5rem', border: '1px solid #222' }}>
            <h3 style={{ marginTop: 0, color: '#00bc6c' }}>Ecosystem Target Lane Route Matrix</h3>
            <select value={activeTrack} onChange={(e) => setActiveTrack(e.target.value as TrackType)} style={{ backgroundColor: '#222', color: '#fff', border: '1px solid #444', padding: '0.5rem', borderRadius: '4px', width: '100%' }}>
              <option value="TRACK_A_YOUTH">Track A: Non-Profit Youth Community (6 Latin Ranks Enforced)</option>
              <option value="TRACK_B_MULTIPROGRAM">Track B: Scalable Multi-Program Transit (N-Task Dynamically Bound)</option>
              <option value="PRO_TRACK_A2P">Pro Track: Adult 18+ Amateur-to-Professional Engine Split</option>
              <option value="B2B_CORPORATE">B2B Track: Corporate Wellness Strategic Partnerships</option>
            </select>
          </div>

          <div style={{ backgroundColor: '#1a1a1a', padding: '1.5rem', borderRadius: '6px', marginBottom: '1.5rem', border: '1px solid #222' }}>
            <h3 style={{ marginTop: 0, color: '#fff' }}>My Assignments</h3>
            <div style={{ border: '1px solid #333', padding: '1.2rem', borderRadius: '4px', backgroundColor: '#222', marginBottom: '1rem' }}>
              <h4 style={{ margin: 0 }}>Shadow Boxing Fundamentals</h4>
              <p style={{ margin: '0.4rem 0', fontSize: '0.85rem', color: '#aaa' }}>Dimension: Boxing Technique Fundamentals | Status: ASSIGNED</p>
              <button onClick={() => handleTaskVerificationRequest("Shadow Boxing Fundamentals", "Boxing Technique Fundamentals")} style={{ backgroundColor: '#00bc6c', border: 0, color: '#fff', padding: '0.4rem 1rem', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}>Request Level Review</button>
            </div>
            <div style={{ border: '1px solid #333', padding: '1.2rem', borderRadius: '4px', backgroundColor: '#222' }}>
              <h4 style={{ margin: 0 }}>Emotional Regulation Drill - Round 2</h4>
              <p style={{ margin: '0.4rem 0', fontSize: '0.85rem', color: '#aaa' }}>Dimension: Emotional Regulation & Stress Response | Status: IN PROGRESS</p>
              <button onClick={() => handleTaskVerificationRequest("Emotional Regulation Drill - Round 2", "Emotional Regulation & Stress Response")} style={{ backgroundColor: '#00bc6c', border: 0, color: '#fff', padding: '0.4rem 1rem', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}>Request Level Review</button>
            </div>
          </div>

          <div style={{ backgroundColor: '#1a1a1a', padding: '1.5rem', borderRadius: '6px', border: '1px solid #222' }}>
            <h3>Layer 7 Advanced Technology: Computer Vision Stance Scan</h3>
            <div style={{ border: '2px dashed #444', padding: '2rem', textAlign: 'center', borderRadius: '4px', backgroundColor: '#222' }}>
              <div style={{ color: '#00bc6c', fontWeight: 'bold' }}>[CAMERA RECORDING HOOK SLOT]</div>
              <span style={{ fontSize: '0.8rem', color: '#888' }}>Telemetry Vectors: Stance Width Consistency | Guard Height Deficits | Punch Extension Angles</span>
            </div>
          </div>
        </section>

        <section>
          <div style={{ backgroundColor: '#1a1a1a', padding: '1.5rem', borderRadius: '6px', border: '1px solid #222' }}>
            <h3 style={{ marginTop: 0 }}>Layer 8 Ingestion Interface</h3>
            <form onSubmit={executePipelineSubmit}>
              {activeTrack === "PRO_TRACK_A2P" && (
                <div style={{ marginBottom: '1rem', padding: '0.75rem', borderLeft: '3px solid #9b59b6', backgroundColor: '#222', fontSize: '0.8rem' }}>
                  <strong>Asynchronous Professional Core Loop Active:</strong><br />Position → Perception → Decision → Action → Defense → Exit → Reset
                </div>
              )}
              <textarea value={reflection} onChange={(e) => setReflection(e.target.value)} rows={6} style={{ width: '100%', backgroundColor: '#222', color: '#fff', border: '1px solid #444', padding: '0.5rem', boxSizing: 'border-box', marginBottom: '1rem', borderRadius: '4px' }} placeholder="Record internal mechanical feedback profiles, timing variations, or physical feedback indices..." disabled={isSubmitting} />
              <button type="submit" disabled={isSubmitting || !reflection.trim()} style={{ width: '100%', backgroundColor: '#00bc6c', border: 0, color: '#fff', padding: '0.6rem', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}>{isSubmitting ? 'Pipelining System Packets...' : 'Submit to Transit Buffer'}</button>
            </form>
            {submitStatus && <div style={{ marginTop: '1rem', padding: '0.75rem', backgroundColor: '#222', borderLeft: '4px solid #00bc6c', fontSize: '0.85rem' }}>{submitStatus}</div>}
          </div>
        </section>
      </main>
      <footer style={{ borderTop: '2px solid #222', padding: '1.5rem', textAlign: 'center', color: '#555', fontSize: '0.8rem', marginTop: '2rem', backgroundColor: '#1a1a1a' }}>{corporateStencil}</footer>
    </div>
  );
}
