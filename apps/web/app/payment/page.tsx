'use client';
import React, { useState } from 'react';
import { processPayment } from '@packages/portals/payment';

export default function PaymentGate() {
  const [result, setResult] = useState<any>(null);
  const [jasonApproval, setJasonApproval] = useState(false);

  const handlePayment = () => {
    const res = processPayment({
      participantId: 'demo-001',
      amount: 0,
      purpose: 'Program access (gated)',
      proofOfSuccess: true,
      jasonApproval,
    });
    setResult(res);
  };

  return (
    <div style={{ padding: '40px', maxWidth: '700px', margin: '0 auto' }}>
      <h1>Payment Service (Gated)</h1>
      <p><strong>Explicitly gated behind proof-of-success and Jason approval.</strong></p>

      <div style={{ margin: '16px 0' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={jasonApproval}
            onChange={(e) => setJasonApproval(e.target.checked)}
          />
          <span>Jason Approval Granted (Layer 0)</span>
        </label>
      </div>

      <button onClick={handlePayment} style={{ padding: '14px 28px', margin: '20px 0' }}>
        Attempt Payment
      </button>

      {result && (
        <div style={{ background: result.success ? '#dcfce7' : '#fee2e2', padding: '20px', borderRadius: '8px' }}>
          <strong>{result.success ? 'Success' : 'Blocked'}</strong><br />
          {result.message || result.reason}
          {result.transactionId && <div style={{ marginTop: 8, fontSize: '0.85em' }}>TX: {result.transactionId}</div>}
        </div>
      )}

      <p style={{ marginTop: 30, fontSize: '0.85em', color: '#666' }}>
        This service (Capability 21) is permanently gated. Both conditions must be true.
      </p>
    </div>
  );
}
