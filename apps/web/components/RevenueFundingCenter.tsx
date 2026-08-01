'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';

type RevenueFundingTab =
  | 'overview'
  | 'memberships'
  | 'donations'
  | 'sponsors'
  | 'b2b'
  | 'wholesale'
  | 'grants'
  | 'scholarships'
  | 'products'
  | 'payment-settings'
  | 'treasurer-review';

type RevenueAccountStatus =
  | 'Lead'
  | 'Contacted'
  | 'Proposal Needed'
  | 'Negotiating'
  | 'Active'
  | 'Inactive'
  | 'Closed'
  | 'Prospect'
  | 'Pending Review'
  | 'Needs Quote';

type RevenueItemStatus =
  | 'Pending Review'
  | 'Active'
  | 'Past Due'
  | 'Waived'
  | 'Scholarship'
  | 'Pledged'
  | 'Received Placeholder'
  | 'Researching'
  | 'Drafting'
  | 'Submitted'
  | 'Awarded Placeholder'
  | 'Declined Placeholder'
  | 'Reporting Due'
  | 'Closed'
  | 'Draft'
  | 'Archived'
  | 'Needs Pricing'
  | 'Needs Review';

interface RevenueAccount {
  id: string;
  name: string;
  accountType: string;
  contactName: string;
  emailPlaceholder: string;
  phonePlaceholder: string;
  category: string;
  status: RevenueAccountStatus;
  assignedOwner: string;
  notes: string;
  createdAt: string;
  updatedAt: string;
}

interface RevenueItem {
  id: string;
  title: string;
  revenueType: string;
  amountPlaceholder: string;
  status: RevenueItemStatus;
  relatedAccountId: string;
  restrictedPurpose: string;
  reviewNeeded: boolean;
  notes: string;
}

type DonationFrequency = 'One-Time' | 'Monthly' | 'Quarterly' | 'Annual';
type DonationLifecycleStatus = 'Pending Review' | 'Pledged' | 'Active' | 'Closed';

interface DonationRecord {
  id: string;
  donorName: string;
  amount: number;
  frequency: DonationFrequency;
  designation: string;
  receiptNeeded: boolean;
  status: DonationLifecycleStatus;
  notes: string;
  createdAt: string;
}

interface PaymentIntegrationPlaceholder {
  provider: string;
  status: 'Not Connected';
  connected: false;
  notes: string;
  futureBackendRequired: true;
}

const revenueAccounts: RevenueAccount[] = [
  {
    id: 'ra_001',
    name: 'Placeholder Youth Family Account',
    accountType: 'Family Membership',
    contactName: 'Guardian Placeholder',
    emailPlaceholder: 'guardian@example.placeholder',
    phonePlaceholder: '(000) 000-0000',
    category: 'Memberships',
    status: 'Pending Review',
    assignedOwner: 'Admin',
    notes: 'Front-end placeholder only.',
    createdAt: '2026-07-12',
    updatedAt: '2026-07-12',
  },
  {
    id: 'ra_002',
    name: 'Placeholder Community Sponsor',
    accountType: 'Local Business',
    contactName: 'Sponsor Contact Placeholder',
    emailPlaceholder: 'sponsor@example.placeholder',
    phonePlaceholder: '(000) 000-0000',
    category: 'Sponsors',
    status: 'Lead',
    assignedOwner: 'Admin',
    notes: 'Sponsor interest tracking only.',
    createdAt: '2026-07-12',
    updatedAt: '2026-07-12',
  },
  {
    id: 'ra_003',
    name: 'Placeholder District Account',
    accountType: 'School',
    contactName: 'District Lead Placeholder',
    emailPlaceholder: 'district@example.placeholder',
    phonePlaceholder: '(000) 000-0000',
    category: 'B2B Accounts',
    status: 'Proposal Needed',
    assignedOwner: 'Admin',
    notes: 'B2B pipeline placeholder.',
    createdAt: '2026-07-12',
    updatedAt: '2026-07-12',
  },
];

const revenueItems: RevenueItem[] = [
  {
    id: 'ri_001',
    title: 'Youth Athlete Membership Placeholder',
    revenueType: 'Membership',
    amountPlaceholder: '$0.00',
    status: 'Pending Review',
    relatedAccountId: 'ra_001',
    restrictedPurpose: 'N/A',
    reviewNeeded: true,
    notes: 'No invoice creation. Front-end planning only.',
  },
  {
    id: 'ri_002',
    title: 'General Donation Placeholder',
    revenueType: 'Donation',
    amountPlaceholder: '$0.00',
    status: 'Pledged',
    relatedAccountId: 'ra_002',
    restrictedPurpose: 'Unrestricted Placeholder',
    reviewNeeded: true,
    notes: 'No tax receipt issuance from this UI.',
  },
  {
    id: 'ri_003',
    title: 'Grant Draft Placeholder',
    revenueType: 'Grant',
    amountPlaceholder: '$0.00',
    status: 'Drafting',
    relatedAccountId: 'ra_003',
    restrictedPurpose: 'Youth Development',
    reviewNeeded: true,
    notes: 'Pipeline tracking only.',
  },
];

const paymentIntegrations: PaymentIntegrationPlaceholder[] = [
  { provider: 'Stripe Placeholder', status: 'Not Connected', connected: false, notes: 'Future Integration | Requires Backend | Requires Compliance Review', futureBackendRequired: true },
  { provider: 'Square Placeholder', status: 'Not Connected', connected: false, notes: 'Future Integration | Requires Backend | Requires Compliance Review', futureBackendRequired: true },
  { provider: 'PayPal Placeholder', status: 'Not Connected', connected: false, notes: 'Future Integration | Requires Backend | Requires Compliance Review', futureBackendRequired: true },
  { provider: 'Donorbox / Givebutter Placeholder', status: 'Not Connected', connected: false, notes: 'Future Integration | Requires Backend | Requires Compliance Review', futureBackendRequired: true },
  { provider: 'QuickBooks Placeholder', status: 'Not Connected', connected: false, notes: 'Future Integration | Requires Backend | Requires Compliance Review', futureBackendRequired: true },
  { provider: 'Microsoft / Power Platform Placeholder', status: 'Not Connected', connected: false, notes: 'Future Integration | Requires Backend | Requires Compliance Review', futureBackendRequired: true },
];

// No donation is recorded here, because this platform holds no financial
// records: every payment integration below reads Not Connected, and the
// payment capability is a reserved slot that is deliberately not built
// (docs/PAYMENT_SERVICE_SLOT.md). A seeded donor with a real amount would be
// read by a treasurer or a board member as money the gym actually received.
const initialDonationRecords: DonationRecord[] = [];

const tabs: Array<{ id: RevenueFundingTab; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'memberships', label: 'Memberships' },
  { id: 'donations', label: 'Donations' },
  { id: 'sponsors', label: 'Sponsors' },
  { id: 'b2b', label: 'B2B Accounts' },
  { id: 'wholesale', label: 'Wholesale Accounts' },
  { id: 'grants', label: 'Grants' },
  { id: 'scholarships', label: 'Scholarships' },
  { id: 'products', label: 'Products / Equipment' },
  { id: 'payment-settings', label: 'Payment Settings Placeholder' },
  { id: 'treasurer-review', label: 'Treasurer Review' },
];

const revenueCapabilities: Array<{ capability: string; state: 'EXISTS' | 'PARTIAL' | 'PLACEHOLDER' | 'MISSING'; detail: string; tab?: RevenueFundingTab }> = [
  { capability: 'Program Membership Tracking', state: 'PARTIAL', detail: 'Membership lanes are present in front-end workflow mode.', tab: 'memberships' },
  { capability: 'Donation Operations', state: 'EXISTS', detail: 'Donation intake and lifecycle status controls are available.', tab: 'donations' },
  { capability: 'Sponsor Management', state: 'PARTIAL', detail: 'Sponsor lanes exist with review queue visibility.', tab: 'sponsors' },
  { capability: 'Grant Tracking', state: 'PARTIAL', detail: 'Grant draft and review lanes are visible in planning mode.', tab: 'grants' },
  { capability: 'Scholarship Tracking', state: 'PARTIAL', detail: 'Scholarship lanes and support status placeholders are visible.', tab: 'scholarships' },
  { capability: 'Funding Intelligence', state: 'PLACEHOLDER', detail: 'Planned capability. Not yet implemented.' },
  { capability: 'Automated Compliance Monitoring', state: 'MISSING', detail: 'No backend automation exists yet.' },
];

function capabilityBadgeTone(state: 'EXISTS' | 'PARTIAL' | 'PLACEHOLDER' | 'MISSING'): string {
  if (state === 'EXISTS') return 'border-[var(--status-ready)] bg-[#dce7ca] text-[var(--black)]';
  if (state === 'PARTIAL') return 'border-[var(--status-warning)] bg-[#efe3c4] text-[var(--black)]';
  if (state === 'PLACEHOLDER') return 'border-[var(--red-primary)] bg-[#f1d6d1] text-[var(--black)]';
  return 'border-[var(--gray-medium)] bg-[var(--canvas-tan)] text-[var(--black)]';
}

function statusTone(status: string): string {
  const normalized = status.toLowerCase();
  if (normalized.includes('active') || normalized.includes('received') || normalized.includes('awarded')) {
    return 'text-[var(--black)] border-[var(--status-ready)] bg-[#dce7ca]';
  }
  if (normalized.includes('pending') || normalized.includes('review') || normalized.includes('draft') || normalized.includes('submitted')) {
    return 'text-[var(--black)] border-[var(--status-warning)] bg-[#efe3c4]';
  }
  if (normalized.includes('past due') || normalized.includes('declined') || normalized.includes('not connected')) {
    return 'text-[var(--black)] border-[var(--red-primary)] bg-[#f1d6d1]';
  }
  return 'text-[var(--black)] border-[var(--gray-medium)] bg-[var(--canvas-tan)]';
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);
}

function SectionCard({ title, children }: Readonly<{ title: string; children: React.ReactNode }>) {
  return (
    <section className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-5">
      <h3 className="text-lg font-bold text-[var(--black)]">{title}</h3>
      <div className="mt-3 text-base text-[var(--gray-dark)]">{children}</div>
    </section>
  );
}

export default function RevenueFundingCenter() {
  const [activeTab, setActiveTab] = useState<RevenueFundingTab>('overview');
  const [donationRecords, setDonationRecords] = useState<DonationRecord[]>(initialDonationRecords);

  const [donorName, setDonorName] = useState('');
  const [donationAmount, setDonationAmount] = useState('');
  const [donationFrequency, setDonationFrequency] = useState<DonationFrequency>('One-Time');
  const [donationDesignation, setDonationDesignation] = useState('General Donation');
  const [donationReceiptNeeded, setDonationReceiptNeeded] = useState(true);
  const [donationNotes, setDonationNotes] = useState('');

  const pendingItems = useMemo(() => {
    const revenuePending = revenueItems.filter((item) => item.reviewNeeded);
    const donationPending = donationRecords
      .filter((item) => item.status === 'Pending Review' || item.status === 'Pledged')
      .map((item) => ({
        id: item.id,
        title: item.donorName,
        revenueType: 'Donation',
        amountPlaceholder: formatCurrency(item.amount),
        status: item.status,
      }));

    return [...revenuePending, ...donationPending];
  }, [donationRecords]);

  const summaryStrip = useMemo(() => {
    const donationPendingCount = donationRecords.filter((item) => item.status === 'Pending Review' || item.status === 'Pledged').length;
    const revenuePendingCount = revenueItems.filter((item) => item.reviewNeeded).length;

    return [
      { label: 'Memberships', value: 2 },
      { label: 'Donations', value: donationRecords.length },
      { label: 'Sponsors', value: 1 },
      { label: 'B2B Accounts', value: 1 },
      { label: 'Wholesale Accounts', value: 1 },
      { label: 'Grants', value: 1 },
      { label: 'Scholarships', value: 1 },
      { label: 'Pending Reviews', value: donationPendingCount + revenuePendingCount },
    ];
  }, [donationRecords]);

  const urgentActions = useMemo(() => {
    return pendingItems.slice(0, 5);
  }, [pendingItems]);

  function resetDonationForm() {
    setDonorName('');
    setDonationAmount('');
    setDonationFrequency('One-Time');
    setDonationDesignation('General Donation');
    setDonationReceiptNeeded(true);
    setDonationNotes('');
  }

  function handleAddDonation() {
    const amount = Number.parseFloat(donationAmount);
    if (!donorName.trim() || Number.isNaN(amount) || amount <= 0) {
      return;
    }

    const next: DonationRecord = {
      id: `don_${Date.now()}`,
      donorName: donorName.trim(),
      amount,
      frequency: donationFrequency,
      designation: donationDesignation.trim() || 'General Donation',
      receiptNeeded: donationReceiptNeeded,
      status: 'Pending Review',
      notes: donationNotes.trim() || 'No additional notes.',
      createdAt: new Date().toISOString().slice(0, 10),
    };

    setDonationRecords((current) => [next, ...current]);
    resetDonationForm();
  }

  function updateDonationStatus(id: string, status: DonationLifecycleStatus) {
    setDonationRecords((current) => current.map((item) => (item.id === id ? { ...item, status } : item)));
  }

  const membershipRows = [
    ['Member Name Placeholder', 'Family / Guardian Placeholder', 'Youth Athlete', '$0.00', 'Pending', 'Start Date Placeholder', 'No card data stored.', 'Yes'],
    ['Member Name Placeholder', 'Family / Guardian Placeholder', 'Scholarship / Waived', '$0.00', 'Scholarship', 'Start Date Placeholder', 'Review scholarship lane.', 'Yes'],
  ];

  const sponsorRows = [
    ['Sponsor Name Placeholder', 'Contact Placeholder', 'Local Business', 'Financial', 'Youth Development', 'Lead', 'Renewal Date Placeholder', 'Needs follow-up.'],
  ];

  const b2bRows = [
    ['Organization Placeholder', 'Contact Placeholder', 'School', 'Proposal Needed', 'Program Support', '$0.00', 'Contract Placeholder', 'Schedule proposal call', 'Pipeline tracking only.'],
  ];

  const wholesaleRows = [
    ['Account Placeholder', 'Retail Partner', 'Contact Placeholder', 'Gloves / Wraps', 'Tier Placeholder', 'Minimum Placeholder', 'Needs Quote', 'Front-end quote staging only.'],
  ];

  const grantRows = [
    ['Grant Placeholder', 'Funder Placeholder', 'Youth Development', '$0.00', 'Drafting', 'Due Date Placeholder', 'Restricted Purpose Placeholder', 'Reporting Required Placeholder', 'Draft package in progress.'],
  ];

  const scholarshipRows = [
    ['Athlete / Family Placeholder', 'Partial Scholarship', '$0.00', 'Sponsor Placeholder', 'Pending Review', 'Yes', 'Internal review only.'],
  ];

  const productRows = [
    ['Product Placeholder', 'Gloves', '$0.00', '$0.00', 'Inventory Placeholder', 'Needs Pricing', 'No checkout enabled.'],
  ];

  const treasurerQueue = [
    ['Membership exception placeholder', 'Memberships', 'Pending Review', 'Yes', 'Exception needs treasurer validation.'],
    ['Donation designation placeholder', 'Donations', 'Pending Review', 'Yes', 'Restricted purpose needs confirmation.'],
    ['Sponsor package placeholder', 'Sponsors', 'Lead', 'Yes', 'Terms review required.'],
    ['Grant draft placeholder', 'Grants', 'Drafting', 'Yes', 'Submission package not finalized.'],
    ['Scholarship request placeholder', 'Scholarships', 'Pending Review', 'Yes', 'Support source not finalized.'],
    ['B2B quote placeholder', 'B2B Accounts', 'Proposal Needed', 'Yes', 'Pricing framework pending.'],
    ['Wholesale tier placeholder', 'Wholesale Accounts', 'Needs Quote', 'Yes', 'Tier validation required.'],
    ['Processor enablement placeholder', 'Payment Integration', 'Not Connected', 'Yes', 'Backend and compliance required.'],
  ];

  return (
    <section className="space-y-6">
      <article className="border-[3px] border-[var(--black)] bg-[var(--canvas-tan-light)] p-6 shadow-[var(--shadow-sm)]">
        <p className="text-[14px] font-mono uppercase tracking-[0.14em] text-[var(--red-primary)]">Revenue Operations</p>
        <h2 className="mt-2 text-[34px] font-black text-[var(--black)]">Revenue & Funding Center</h2>
        <p className="mt-3 text-base leading-7 text-[var(--gray-dark)]">
          Front-end control surface for memberships, donations, sponsors, B2B accounts, wholesale accounts, grants, scholarships, and funding workflows.
        </p>
        <p className="mt-3 text-sm font-mono uppercase tracking-[0.14em] text-[var(--gray-dark)]">Old Gauze | Sweat | Grit | Grind | Dedication | Motivation</p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Link
            href="/help#revenue-guide"
            className="inline-flex min-h-[40px] items-center justify-center border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-3 text-xs font-mono font-bold uppercase tracking-[0.12em] text-[var(--black)] transition hover:bg-[var(--canvas-tan-dark)]"
          >
            HOW THIS WORKS
          </Link>
          <Link
            href="/help#planned-capabilities-guide"
            className="inline-flex min-h-[40px] items-center justify-center border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-3 text-xs font-mono font-bold uppercase tracking-[0.12em] text-[var(--black)] transition hover:bg-[var(--canvas-tan-dark)]"
          >
            Planned Systems
          </Link>
        </div>
      </article>

      <section className="border-2 border-[var(--black)] bg-[var(--canvas-tan)] p-4">
        <p className="text-sm font-semibold text-[var(--red-primary)]">Mission Funding Mindset</p>
        <p className="mt-1 text-sm text-[var(--gray-dark)]">Every dollar supports discipline, safety, and long-term growth. Keep the work clean, accountable, and purpose-driven.</p>
      </section>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {summaryStrip.map((item) => (
          <article key={item.label} className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] px-4 py-4">
            <p className="text-[14px] font-mono uppercase tracking-[0.1em] text-[var(--red-primary)]">{item.label}</p>
            <p className="mt-2 text-[30px] font-black text-[var(--black)]">{item.value}</p>
          </article>
        ))}
      </section>

      <section className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-4">
        <h3 className="text-base font-black text-[var(--black)]">Action Center</h3>
        <p className="mt-1 text-sm text-[var(--gray-dark)]">Triage these items first to keep operations moving.</p>
        <div className="mt-3 grid gap-2">
          {urgentActions.length === 0 ? (
            <p className="border border-[var(--black)] bg-[var(--canvas-tan)] px-3 py-3 text-sm text-[var(--gray-dark)]">No urgent actions right now.</p>
          ) : (
            urgentActions.map((item) => (
              <button
                key={`urgent-${item.id}`}
                type="button"
                onClick={() => setActiveTab('treasurer-review')}
                className="flex min-h-[44px] items-center justify-between gap-3 border border-[var(--black)] bg-[var(--canvas-tan)] px-3 py-2 text-left transition hover:bg-[var(--canvas-tan-dark)]"
              >
                <span className="text-sm font-semibold text-[var(--black)]">{item.title}</span>
                <span className={`border px-2 py-1 text-xs font-semibold ${statusTone(item.status)}`}>{item.status}</span>
              </button>
            ))
          )}
        </div>
      </section>

      <details className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-4">
        <summary className="cursor-pointer text-base font-black text-[var(--black)]">Capability Visibility (Revenue)</summary>
        <div className="mt-2">
        <h3 className="text-base font-black text-[var(--black)]">Capability Visibility (Revenue)</h3>
        <p className="mt-1 text-sm text-[var(--gray-dark)]">Status map is front-end only and intended to improve discoverability and roadmap clarity.</p>
        <div className="mt-3 grid gap-2 md:grid-cols-2">
          {revenueCapabilities.map((item) => (
            <article key={item.capability} className={`border p-3 ${capabilityBadgeTone(item.state)}`}>
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-bold uppercase tracking-[0.06em]">{item.capability}</p>
                <span className="border border-[var(--black)] bg-[var(--canvas-tan-light)] px-2 py-0.5 text-[10px] font-mono font-bold uppercase">{item.state}</span>
              </div>
              <p className="mt-2 text-xs leading-5">{item.detail}</p>
              {item.tab ? (
                <button
                  type="button"
                  onClick={() => {
                    if (item.tab) {
                      setActiveTab(item.tab)
                    }
                  }}
                  className="mt-3 inline-flex min-h-[38px] items-center border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] px-3 text-xs font-bold uppercase tracking-[0.08em] text-[var(--black)] transition hover:bg-[var(--canvas-tan)]"
                >
                  Open Capability
                </button>
              ) : (
                <button
                  type="button"
                  disabled
                  className="mt-3 inline-flex min-h-[38px] cursor-not-allowed items-center border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] px-3 text-xs font-bold uppercase tracking-[0.08em] text-[var(--red-primary)] opacity-80"
                >
                  Planned Capability
                </button>
              )}
            </article>
          ))}
        </div>
        </div>
      </details>

      <section className="flex flex-wrap gap-2 border-2 border-[var(--black)] bg-[var(--canvas-tan)] p-2">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActiveTab(tab.id)}
            className={`min-h-[44px] border px-4 text-[14px] font-bold ${
              activeTab === tab.id
                ? 'border-[var(--black)] bg-[var(--red-primary)] text-[var(--canvas-tan-light)]'
                : 'border-[var(--black)] bg-[var(--canvas-tan-light)] text-[var(--black)] hover:bg-[var(--canvas-tan-dark)]'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </section>

      {activeTab === 'overview' && (
        <section className="grid gap-4 lg:grid-cols-2">
          <SectionCard title="Revenue Lane Summary">
            <div className="grid gap-3 md:grid-cols-2">
              <div className="border-2 border-[var(--black)] bg-[var(--canvas-tan)] p-4">
                <p className="text-lg font-bold text-[var(--black)]">Operational Revenue</p>
                <ul className="mt-2 space-y-1 text-base">
                  <li>Memberships</li>
                  <li>Products / Equipment</li>
                  <li>Wholesale Accounts</li>
                  <li>B2B Accounts</li>
                </ul>
              </div>
              <div className="border-2 border-[var(--black)] bg-[var(--canvas-tan)] p-4">
                <p className="text-lg font-bold text-[var(--black)]">Philanthropic / Nonprofit Funding</p>
                <ul className="mt-2 space-y-1 text-base">
                  <li>Donations</li>
                  <li>Sponsors</li>
                  <li>Grants</li>
                  <li>Scholarships</li>
                </ul>
              </div>
            </div>
          </SectionCard>

          <SectionCard title="Pending Payment/Funding Items">
            <div className="space-y-2">
              {pendingItems.map((item) => (
                <div key={item.id} className="flex flex-wrap items-center justify-between gap-3 border-2 border-[var(--black)] bg-[var(--canvas-tan)] p-3">
                  <div>
                    <p className="text-base font-semibold text-[var(--black)]">{item.title}</p>
                    <p className="text-[14px] text-[var(--gray-dark)]">{item.revenueType} | {item.amountPlaceholder}</p>
                  </div>
                  <span className={`border px-2 py-1 text-[14px] font-semibold ${statusTone(item.status)}`}>{item.status}</span>
                </div>
              ))}
            </div>
          </SectionCard>

          <SectionCard title="Donor/Sponsor Interest Placeholder">
            <p>Donor and sponsor outreach is tracked as placeholder pipeline entries pending admin and treasurer review.</p>
          </SectionCard>

          <SectionCard title="B2B Account Pipeline">
            <p>Lead {'->'} Contacted {'->'} Proposal Needed {'->'} Negotiating {'->'} Active lifecycle placeholder.</p>
          </SectionCard>

          <SectionCard title="Wholesale Account Pipeline">
            <p>Prospect {'->'} Needs Quote {'->'} Pending Review {'->'} Active lifecycle placeholder.</p>
          </SectionCard>

          <SectionCard title="Grant Funding Pipeline">
            <p>Researching {'->'} Drafting {'->'} Submitted {'->'} Awarded Placeholder / Declined Placeholder lifecycle placeholder.</p>
          </SectionCard>

          <SectionCard title="Scholarship Support Summary">
            <p>Support lanes include full scholarship, partial scholarship, participation support waiver, equipment assistance, and program support placeholders.</p>
          </SectionCard>

          <SectionCard title="Treasurer Review Queue">
            <p>Items requiring finance oversight are tracked in the Treasurer Review tab with review-needed markers.</p>
          </SectionCard>

          <SectionCard title="SHADOW FUNDING WATCH">
            <ul className="space-y-2 text-base">
              <li>- Donation review pending</li>
              <li>- Grant reporting placeholder</li>
              <li>- Sponsor follow-up needed</li>
              <li>- B2B account needs next step</li>
              <li>- Scholarship review needed</li>
              <li>- Payment processor not connected</li>
            </ul>
          </SectionCard>

          <SectionCard title="Future Intake Routing Placeholder">
            <p>Future intake routing: Public Portal {'->'} Admin Review {'->'} Revenue & Funding Center.</p>
          </SectionCard>
        </section>
      )}

      {activeTab === 'memberships' && (
        <SectionCard title="Membership Tracking">
          <div className="space-y-3">
            {membershipRows.map((row) => (
              <div key={row.join('|')} className="border-2 border-[var(--black)] bg-[var(--canvas-tan)] p-4">
                <p className="text-lg font-bold text-[var(--black)]">{row[0]}</p>
                <p className="text-[14px] text-[var(--gray-dark)]">{row[1]} | Membership Type: {row[2]} | Amount Placeholder: {row[3]}</p>
                <p className="mt-1 text-base">Status: {row[4]} | Start Date: {row[5]}</p>
                <p className="mt-1 text-base">Notes: {row[6]} | Admin Review Needed: {row[7]}</p>
              </div>
            ))}
            <p className="text-[14px] text-[var(--gray-dark)]">Membership types: Youth Athlete, Adult Fitness, Competition Track, Adaptive Training, Family Membership, Scholarship / Waived, Custom.</p>
          </div>
        </SectionCard>
      )}

      {activeTab === 'donations' && (
        <SectionCard title="Donation Tracking">
          <div className="space-y-4">
            <div className="border-2 border-[var(--black)] bg-[var(--canvas-tan)] p-4">
              <p className="text-lg font-bold text-[var(--black)]">Add Donation Entry</p>
              <p className="mt-1 text-[14px] text-[var(--gray-dark)]">Tracks donation intent and review status for operations and treasurer visibility.</p>

              <div className="mt-3 grid gap-3 md:grid-cols-2">
                <div>
                  <label htmlFor="donor-name" className="mb-1 block text-[14px] font-semibold text-[var(--gray-dark)]">Donor Name</label>
                  <input
                    id="donor-name"
                    value={donorName}
                    onChange={(event) => setDonorName(event.target.value)}
                    className="h-11 w-full border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] px-3 text-[16px] text-[var(--black)]"
                  />
                </div>
                <div>
                  <label htmlFor="donation-amount" className="mb-1 block text-[14px] font-semibold text-[var(--gray-dark)]">Amount (USD)</label>
                  <input
                    id="donation-amount"
                    type="number"
                    min="1"
                    step="0.01"
                    value={donationAmount}
                    onChange={(event) => setDonationAmount(event.target.value)}
                    className="h-11 w-full border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] px-3 text-[16px] text-[var(--black)]"
                  />
                </div>
                <div>
                  <label htmlFor="donation-frequency" className="mb-1 block text-[14px] font-semibold text-[var(--gray-dark)]">Frequency</label>
                  <select
                    id="donation-frequency"
                    value={donationFrequency}
                    onChange={(event) => setDonationFrequency(event.target.value as DonationFrequency)}
                    className="h-11 w-full border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] px-3 text-[16px] text-[var(--black)]"
                  >
                    <option value="One-Time">One-Time</option>
                    <option value="Monthly">Monthly</option>
                    <option value="Quarterly">Quarterly</option>
                    <option value="Annual">Annual</option>
                  </select>
                </div>
                <div>
                  <label htmlFor="donation-designation" className="mb-1 block text-[14px] font-semibold text-[var(--gray-dark)]">Designation</label>
                  <input
                    id="donation-designation"
                    value={donationDesignation}
                    onChange={(event) => setDonationDesignation(event.target.value)}
                    className="h-11 w-full border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] px-3 text-[16px] text-[var(--black)]"
                  />
                </div>
                <div className="md:col-span-2">
                  <label htmlFor="donation-notes" className="mb-1 block text-[14px] font-semibold text-[var(--gray-dark)]">Notes</label>
                  <textarea
                    id="donation-notes"
                    value={donationNotes}
                    onChange={(event) => setDonationNotes(event.target.value)}
                    className="min-h-[90px] w-full border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] px-3 py-2 text-[16px] text-[var(--black)]"
                  />
                </div>
                <label className="flex items-center gap-2 text-[14px] text-[var(--gray-dark)] md:col-span-2">
                  <input
                    type="checkbox"
                    checked={donationReceiptNeeded}
                    onChange={(event) => setDonationReceiptNeeded(event.target.checked)}
                  />
                  <span>Receipt needed</span>
                </label>
              </div>

              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  onClick={handleAddDonation}
                  className="h-11 border-2 border-[var(--black)] bg-[var(--red-primary)] px-4 text-[14px] font-bold text-[var(--canvas-tan-light)]"
                >
                  Add Donation
                </button>
                <button
                  type="button"
                  onClick={resetDonationForm}
                  className="h-11 border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] px-4 text-[14px] font-bold text-[var(--black)]"
                >
                  Reset
                </button>
              </div>
            </div>

            <div className="space-y-3">
              {donationRecords.length === 0 && (
                <div className="border-2 border-[var(--black)] bg-[var(--canvas-tan)] p-4">
                  <p className="text-base font-semibold">No donations are recorded.</p>
                  <p className="mt-1 text-base">
                    This platform holds no financial records. Donations, grants and fees live in the
                    gym&apos;s own books until a payment processor is connected.
                  </p>
                </div>
              )}
              {donationRecords.map((row) => (
                <div key={row.id} className="border-2 border-[var(--black)] bg-[var(--canvas-tan)] p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="text-lg font-bold text-[var(--black)]">{row.donorName}</p>
                      <p className="text-base">Designation: {row.designation} | Amount: {formatCurrency(row.amount)} | Frequency: {row.frequency}</p>
                      <p className="text-base">Receipt Needed: {row.receiptNeeded ? 'Yes' : 'No'} | Added: {row.createdAt}</p>
                      <p className="text-base">Notes: {row.notes}</p>
                    </div>
                    <div className="space-y-2">
                      <span className={`inline-block border px-2 py-1 text-[14px] font-semibold ${statusTone(row.status)}`}>{row.status}</span>
                      <select
                        value={row.status}
                        onChange={(event) => updateDonationStatus(row.id, event.target.value as DonationLifecycleStatus)}
                        className="h-10 border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] px-2 text-[14px] text-[var(--black)]"
                      >
                        <option value="Pending Review">Pending Review</option>
                        <option value="Pledged">Pledged</option>
                        <option value="Active">Active</option>
                        <option value="Closed">Closed</option>
                      </select>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <p className="text-[14px] text-[var(--gray-dark)]">Donation types supported in this lane: General Donation, Youth Program Support, Equipment Support, Scholarship Support, Facility Support, Event Support.</p>
            <p className="border-2 border-[var(--black)] bg-[var(--canvas-tan)] p-3 text-[14px] text-[var(--red-primary)]">Operational tracking only. Payment processing and tax receipt issuance still require backend integration.</p>
          </div>
        </SectionCard>
      )}

      {activeTab === 'sponsors' && (
        <SectionCard title="Sponsor Tracking">
          <div className="space-y-3">
            {sponsorRows.map((row) => (
              <div key={row.join('|')} className="border-2 border-[var(--black)] bg-[var(--canvas-tan)] p-4">
                <p className="text-lg font-bold text-[var(--black)]">{row[0]}</p>
                <p className="text-base">Contact: {row[1]} | Sponsor Type: {row[2]} | Support Type: {row[3]}</p>
                <p className="text-base">Program Supported: {row[4]} | Status: {row[5]} | Renewal Date: {row[6]}</p>
                <p className="text-base">Notes: {row[7]}</p>
              </div>
            ))}
            <p className="text-[14px] text-[var(--gray-dark)]">Sponsor types: Local Business, Community Partner, Veteran Organization, School Partner, Event Sponsor, Equipment Sponsor, General Sponsor.</p>
            <p className="text-[14px] text-[var(--gray-dark)]">Support types: Financial, Equipment, Services, Facility, Event Support, Volunteer Support.</p>
          </div>
        </SectionCard>
      )}

      {activeTab === 'b2b' && (
        <SectionCard title="B2B Account Tracking">
          <div className="space-y-3">
            {b2bRows.map((row) => (
              <div key={row.join('|')} className="border-2 border-[var(--black)] bg-[var(--canvas-tan)] p-4">
                <p className="text-lg font-bold text-[var(--black)]">{row[0]}</p>
                <p className="text-base">Contact: {row[1]} | Account Type: {row[2]} | Lead Status: {row[3]}</p>
                <p className="text-base">Program Interest: {row[4]} | Estimated Value Placeholder: {row[5]}</p>
                <p className="text-base">Contract / Agreement: {row[6]} | Next Step: {row[7]}</p>
                <p className="text-base">Notes: {row[8]}</p>
              </div>
            ))}
            <p className="text-[14px] text-[var(--gray-dark)]">B2B account types: School, Youth Agency, Municipality, Veterans Organization, Community Organization, Corporate Wellness, Partner Training Center, Athletic Club, Other.</p>
            <p className="text-[14px] text-[var(--gray-dark)]">Lead statuses: Lead, Contacted, Proposal Needed, Negotiating, Active, Inactive, Closed.</p>
          </div>
        </SectionCard>
      )}

      {activeTab === 'wholesale' && (
        <SectionCard title="Wholesale Account Tracking">
          <div className="space-y-3">
            {wholesaleRows.map((row) => (
              <div key={row.join('|')} className="border-2 border-[var(--black)] bg-[var(--canvas-tan)] p-4">
                <p className="text-lg font-bold text-[var(--black)]">{row[0]}</p>
                <p className="text-base">Account Type: {row[1]} | Contact: {row[2]} | Product Interest: {row[3]}</p>
                <p className="text-base">Pricing Tier: {row[4]} | Minimum Order: {row[5]} | Status: {row[6]}</p>
                <p className="text-base">Notes: {row[7]}</p>
              </div>
            ))}
            <p className="text-[14px] text-[var(--gray-dark)]">Wholesale account types: Retail Partner, Club Partner, School Program, Training / Fitness Facility, Event Vendor, Fundraising Partner.</p>
            <p className="text-[14px] text-[var(--gray-dark)]">Statuses: Prospect, Active, Pending Review, Needs Quote, Inactive.</p>
          </div>
        </SectionCard>
      )}

      {activeTab === 'grants' && (
        <SectionCard title="Grant Pipeline Tracking">
          <div className="space-y-3">
            {grantRows.map((row) => (
              <div key={row.join('|')} className="border-2 border-[var(--black)] bg-[var(--canvas-tan)] p-4">
                <p className="text-lg font-bold text-[var(--black)]">{row[0]}</p>
                <p className="text-base">Funder: {row[1]} | Program Area: {row[2]} | Amount Placeholder: {row[3]}</p>
                <p className="text-base">Status: {row[4]} | Due Date: {row[5]} | Restricted Purpose: {row[6]}</p>
                <p className="text-base">Reporting Required: {row[7]} | Notes: {row[8]}</p>
              </div>
            ))}
            <p className="text-[14px] text-[var(--gray-dark)]">Program areas: Youth Development, Fitness / Wellness, Veteran-Owned Community Work, Facility, Equipment, Technology, Safety, Education, Adaptive Training.</p>
          </div>
        </SectionCard>
      )}

      {activeTab === 'scholarships' && (
        <SectionCard title="Scholarship Tracking">
          <div className="space-y-3">
            {scholarshipRows.map((row) => (
              <div key={row.join('|')} className="border-2 border-[var(--black)] bg-[var(--canvas-tan)] p-4">
                <p className="text-lg font-bold text-[var(--black)]">{row[0]}</p>
                <p className="text-base">Support Type: {row[1]} | Amount Placeholder: {row[2]}</p>
                <p className="text-base">Sponsor / Funding Source: {row[3]} | Status: {row[4]} | Review Needed: {row[5]}</p>
                <p className="text-base">Notes: {row[6]}</p>
              </div>
            ))}
            <p className="text-[14px] text-[var(--gray-dark)]">Support types: Full Scholarship, Partial Scholarship, Participation Support Waiver, Equipment Assistance, Competition Participation Support, Travel Support, Program Support.</p>
            <p className="border-2 border-[var(--black)] bg-[var(--canvas-tan)] p-3 text-[14px] text-[var(--red-primary)]">Scholarship tracking is for internal review only and does not expose private financial data to public users.</p>
          </div>
        </SectionCard>
      )}

      {activeTab === 'products' && (
        <SectionCard title="Products / Equipment Placeholder Catalog">
          <div className="space-y-3">
            {productRows.map((row) => (
              <div key={row.join('|')} className="border-2 border-[var(--black)] bg-[var(--canvas-tan)] p-4">
                <p className="text-lg font-bold text-[var(--black)]">{row[0]}</p>
                <p className="text-base">Category: {row[1]} | Retail Price Placeholder: {row[2]} | Wholesale Price Placeholder: {row[3]}</p>
                <p className="text-base">Inventory Placeholder: {row[4]} | Status: {row[5]}</p>
                <p className="text-base">Notes: {row[6]}</p>
              </div>
            ))}
            <p className="text-[14px] text-[var(--gray-dark)]">Categories: Gloves, Wraps, Apparel, Training Gear, Club Packages, Fundraiser Items, Wholesale Bundles.</p>
            <p className="text-[14px] text-[var(--gray-dark)]">No cart, checkout, tax, or shipping logic is implemented in this front-end placeholder.</p>
          </div>
        </SectionCard>
      )}

      {activeTab === 'payment-settings' && (
        <SectionCard title="Payment Settings Placeholder">
          <div className="grid gap-3 md:grid-cols-2">
            {paymentIntegrations.map((integration) => (
              <article key={integration.provider} className="border-2 border-[var(--black)] bg-[var(--canvas-tan)] p-4">
                <p className="text-lg font-bold text-[var(--black)]">{integration.provider}</p>
                <p className="mt-2 text-base text-[var(--red-primary)]">{integration.status}</p>
                <p className="text-[14px] text-[var(--gray-dark)]">{integration.notes}</p>
              </article>
            ))}
          </div>
          <p className="mt-4 border-2 border-[var(--black)] bg-[var(--canvas-tan)] p-3 text-[14px] text-[var(--red-primary)]">No payment processor is connected. This application does not currently process real payments.</p>
        </SectionCard>
      )}

      {activeTab === 'treasurer-review' && (
        <SectionCard title="Membership Oversight Queue">
          <p className="text-base">Membership Oversight View - Future Board Integration.</p>
          <div className="mt-3 space-y-2">
            {treasurerQueue.map((item) => (
              <div key={item.join('|')} className="border-2 border-[var(--black)] bg-[var(--canvas-tan)] p-3">
                <p className="text-lg font-semibold text-[var(--black)]">{item[0]}</p>
                <p className="text-base">Category: {item[1]} | Status: {item[2]} | Review Needed: {item[3]}</p>
                <p className="text-base">Notes: {item[4]}</p>
              </div>
            ))}
            {donationRecords
              .filter((item) => item.status === 'Pending Review' || item.status === 'Pledged')
              .map((item) => (
                <div key={`treasurer-${item.id}`} className="border-2 border-[var(--black)] bg-[var(--canvas-tan)] p-3">
                  <p className="text-lg font-semibold text-[var(--black)]">Donation Review - {item.donorName}</p>
                  <p className="text-base">Category: Donations | Status: {item.status} | Review Needed: Yes</p>
                  <p className="text-base">Amount: {formatCurrency(item.amount)} | Designation: {item.designation}</p>
                </div>
              ))}
          </div>
        </SectionCard>
      )}

      <section className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-5">
        <h3 className="text-lg font-bold text-[var(--black)]">Compliance Boundary</h3>
        <p className="mt-2 text-base leading-7 text-[var(--gray-dark)]">
          Front-end planning tool only. This screen does not process payments, issue receipts, create invoices, calculate taxes, store card data, or provide legal/financial advice.
        </p>
      </section>

      <details className="border-2 border-[var(--black)] bg-[var(--canvas-tan)] p-4">
        <summary className="cursor-pointer text-base font-semibold text-[var(--black)]">Local Placeholder Data Structures</summary>
        <div className="mt-3 space-y-2 text-[14px] text-[var(--gray-dark)]">
          <p>RevenueAccount: id, name, accountType, contactName, emailPlaceholder, phonePlaceholder, category, status, assignedOwner, notes, createdAt, updatedAt.</p>
          <p>RevenueItem: id, title, revenueType, amountPlaceholder, status, relatedAccountId, restrictedPurpose, reviewNeeded, notes.</p>
          <p>DonationRecord: id, donorName, amount, frequency, designation, receiptNeeded, status, notes, createdAt.</p>
          <p>PaymentIntegrationPlaceholder: provider, status, connected, notes, futureBackendRequired.</p>
          <p>Loaded Accounts: {revenueAccounts.length} | Loaded Items: {revenueItems.length} | Loaded Donations: {donationRecords.length} | Loaded Integrations: {paymentIntegrations.length}</p>
        </div>
      </details>
    </section>
  );
}

