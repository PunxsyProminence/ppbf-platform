// packages/continuity/ledger.ts
// Build Continuity Ledger (Capability #22) - Pointer memory, append-only, duplicate detection

export interface DecisionLogEntry {
  id: string;
  timestamp: string;
  decisionType: 'APPROVE' | 'SAFETY_PAUSE' | 'ADJUST' | 'PROMOTION' | 'REJECTION';
  actor: string; // 'coach' | 'jason' etc. (pointer only)
  targetId: string;
  rationale: string;
  governanceFlag: boolean;
}

export class ContinuityLedger {
  private logs: DecisionLogEntry[] = [];

  recordDecision(entry: Omit<DecisionLogEntry, 'id' | 'timestamp'>): DecisionLogEntry {
    const full: DecisionLogEntry = {
      ...entry,
      id: 'log-' + Date.now(),
      timestamp: new Date().toISOString(),
    };
    this.logs.push(full);
    return full;
  }

  getLogs(): DecisionLogEntry[] {
    return [...this.logs];
  }

  findDuplicates(): DecisionLogEntry[] {
    const seen = new Map<string, DecisionLogEntry>();
    const dups: DecisionLogEntry[] = [];
    for (const log of this.logs) {
      const key = `${log.targetId}:${log.decisionType}`;
      if (seen.has(key)) dups.push(log);
      else seen.set(key, log);
    }
    return dups;
  }

  // Promotion requires Jason approval simulation
  requestPromotion(logId: string, approver: string): string {
    const log = this.logs.find(l => l.id === logId);
    if (!log) return 'NOT_FOUND';
    if (approver.toLowerCase() !== 'jason') return 'JASON_APPROVAL_REQUIRED';
    log.governanceFlag = true;
    return 'PROMOTED';
  }
}

export const ledger = new ContinuityLedger();
