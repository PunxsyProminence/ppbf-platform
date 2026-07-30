// @ts-ignore - JSON module import (works with resolveJsonModule + bundler)
import capabilitiesData from '../../PPBF_CAPABILITIES.json';

const capabilities: any = (capabilitiesData as any).default ?? capabilitiesData;

// The file has no top-level "capabilities" key -- the numbered, {id, status}
// registry that isFeatureEnabled and getEnabledCapabilities are meant to read
// lives under "original25Capabilities". Reading "capabilities.capabilities"
// (undefined) and calling .find/.filter on it threw a TypeError on every call,
// unconditionally -- this had never once returned a boolean. It went
// unnoticed because runSafetyGate, the only caller, is itself never invoked
// from apps/web; the medical-clearance behaviour it was meant to gate is
// enforced separately by contactClearanceGate.ts.
//
// "expandedDetailedCapabilities" is a different shape entirely -- free-text
// descriptive lists grouped by subsystem, no id or status field -- and is
// intentionally not consulted here.
//
// Every entry in original25Capabilities is currently "status": "DRAFT", and
// the file's own top-level "governance" object says why:
// { "active": false, "promotionRequired": true }. That is this project's
// explicit statement that nothing here has been promoted yet, so
// isFeatureEnabled correctly returns false for every id post-fix -- this
// corrects the crash, not the DRAFT statuses, which are a project decision
// this file has no authority to make.
const CAPABILITY_REGISTRY: Array<{ id: number; status: string }> =
  capabilities.original25Capabilities ?? [];

export function isFeatureEnabled(capabilityId: number): boolean {
  const cap = CAPABILITY_REGISTRY.find((c) => c.id === capabilityId);
  return cap?.status === 'active' || false;
}

export function getEnabledCapabilities() {
  return CAPABILITY_REGISTRY.filter((c) => c.status === 'active');
}

export const ROUTING_MATRIX = {
  ranks: capabilities.routingMatrix?.ranks || 6,
  lifecycleTags: capabilities.lifecycleTags || [],
  taskDimensions: capabilities.taskDimensions || [],
};
