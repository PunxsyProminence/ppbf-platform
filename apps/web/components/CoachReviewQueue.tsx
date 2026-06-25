'use client';

import React from 'react';

export default function CoachReviewQueue() {
  return (
    <div className="p-8 max-w-4xl mx-auto">
      <h1 className="text-3xl font-bold mb-6">Coach Review Queue</h1>
      <p className="mb-4 text-gray-600">Merged with Safety Gate + Red Flag Escalation</p>
      
      <div className="border rounded-xl p-6 bg-white shadow">
        <p className="mb-4">Sample Review Card</p>
        <div className="flex gap-3">
          <button className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700">
            Approve
          </button>
          <button className="px-4 py-2 bg-yellow-500 text-white rounded-lg hover:bg-yellow-600">
            Adjust
          </button>
          <button className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700">
            Pause
          </button>
        </div>
      </div>
    </div>
  );
}
