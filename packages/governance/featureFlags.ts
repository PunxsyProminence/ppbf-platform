// @ts-ignore - JSON module import (works with resolveJsonModule + bundler)
import capabilitiesData from '../../PPBF_CAPABILITIES.json';

const capabilities: any = (capabilitiesData as any).default ?? capabilitiesData;

export function isFeatureEnabled(capabilityId: number): boolean {
  const cap = capabilities.capabilities.find((c: any) => c.id === capabilityId);
  return cap?.status === 'active' || false;
}

export function getEnabledCapabilities() {
  return capabilities.capabilities.filter((c: any) => c.status === 'active');
}

export const ROUTING_MATRIX = {
  ranks: capabilities.routingMatrix?.ranks || 6,
  lifecycleTags: capabilities.lifecycleTags || [],
  taskDimensions: capabilities.taskDimensions || [],
};
