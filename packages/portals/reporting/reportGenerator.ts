import { generateImpactReport } from './impactReport';

export function generateMonthlyReport(month: string, data: any) {
  const baseReport = generateImpactReport(data);
  
  return {
    ...baseReport,
    month,
    generatedAt: new Date().toISOString(),
    governed: true,
    requiresJasonApproval: true,
  };
}
