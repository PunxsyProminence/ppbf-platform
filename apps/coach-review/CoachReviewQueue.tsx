'use client';

import React from 'react';

export default function CoachReviewQueue() {
  return (
    <div className="p-8">
      <h1 className="text-3xl font-bold mb-6">Coach Review Queue</h1>
      <p className="mb-4">Merged with Safety Gate + Red Flag Escalation.</p>
      
      <div className="border p-6 rounded-lg">
        <p>Sample Review Card</p>
        <button className="mt-4 px-4 py-2 bg-green-600 text-white rounded">
          Approve
        </button>
      </div>
    </div>
  );
}
