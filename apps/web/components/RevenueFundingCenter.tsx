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
  if (state === 'EXISTS') return 'border-[color:var(--brass-600)] bg-[var(--brass-300)] text-[color:var(--hide-950)]';
  if (state === 'PARTIAL') return 'border-[color:var(--brass-600)] text-[color:var(--brass-300)]';
  if (state === 'PLACEHOLDER') return 'border-[color:var(--brass-800)] text-[color:var(--bone-400)]';
  return 'border-[color:rgba(212,175,74,.24)] text-[color:var(--bone-400)]';
}

function statusTone(status: string): string {
  const normalized = status.toLowerCase();
  if (normalized.includes('active') || normalized.includes('received') || normalized.includes('awarded')) {
    return 'border-[color:var(--brass-600)] bg-[var(--brass-300)] text-[color:var(--hide-950)]';
  }
  if (normalized.includes('pending') || normalized.includes('review') || normalized.includes('draft') || normalized.includes('submitted')) {
    return 'border-[color:var(--brass-600)] text-[color:var(--brass-300)]';
  }
  if (normalized.includes('past due') || normalized.includes('declined') || normalized.includes('not connected')) {
    return 'border-[color:var(--brass-800)] text-[color:var(--bone-400)]';
  }
  return 'border-[color:rgba(212,175,74,.24)] text-[color:var(--bone-400)]';
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);
}

function SectionCard({ title, children }: Readonly<{ title: string; children: React.ReactNode }>) {
  return (
    <section className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s5)]">
      <h3 className="t-command">{title}</h3>
      <div className="t-body mt-[var(--s3)]">{children}</div>
    </section>
  );
}

// The declaration that has to sit above the Memberships, Grants and
// Scholarships rows, and the door out to the records those rows are pretending
// to be.
//
// Every row in this component is hardcoded: the file performs no fetch of any
// kind, so each name, status and dollar figure below was typed by a developer
// and none of it came from the gym's books. That was survivable while the
// platform stored nothing. It is not survivable now, because for exactly these
// three lanes it does: /admin/memberships is a live table-backed membership
// register in which a scholarship is a stored discount percentage on a real
// membership row, and /admin/grants is the live grant-obligation ledger. So an
// admin opening the Revenue tab reads "Grant Placeholder | $0.00 | Drafting"
// as the state of the organisation's grant work while the real ledger sits one
// click away, and nothing on the screen tells them which one they are looking
// at.
//
// For a 501(c)(3) that is not a cosmetic problem. A fabricated dollar amount or
// row count carried out of this screen into a board packet, a funder's progress
// report or a 990 work paper becomes a false statement made by the
// organisation, over the signature of whoever sent it -- and the person who
// sent it will have believed they were reading their own records.
//
// Law 7: a refusal is a stamp, not an error toast. This is the same mark the
// other drawn-not-wired consoles carry -- the brass "Planned — Not Yet
// Implemented" plus a sentence naming the rows as fabricated sample data, as in
// src/components/coach/FloorOperationsDesk.tsx, CoachWorkspace.tsx's
// Development tab, and app/admin/page.tsx's integration-stub list. It goes one
// step further than those three only because it can: those consoles have no
// real surface to hand the reader over to, and these tabs do, so the honest
// message also carries the door. Wiring the real reads into this component is a
// larger piece of work and a separate decision; it is deliberately not done
// here, and this notice is what stands in for it until it is.
function FabricatedRowsNotice({
  rows,
  realRecords,
  href,
  linkLabel,
}: Readonly<{ rows: string; realRecords: string; href: string; linkLabel: string }>) {
  return (
    <div className="mat-leather rounded-[var(--r-md)] border border-[color:rgba(212,175,74,.24)] p-[var(--s4)]">
      <p><span className="stamp stamp--brass stamp--flat">Planned — Not Yet Implemented</span></p>
      <p className="t-body mt-[var(--s3)]">
        Every {rows} row below is fabricated sample data. This tab makes no request and reads no
        record, so nothing on it is your organisation&apos;s — do not act on anything it shows, and do
        not copy a figure from it into a board packet, a grant report, or a filing. For a 501(c)(3),
        a fabricated financial figure that reaches a funder or a board becomes a false statement by
        the organisation.
      </p>
      <p className="t-body mt-[var(--s2)]">{realRecords}</p>
      <Link href={href} className="btn btn--ghost mt-[var(--s3)]">
        {linkLabel}
      </Link>
    </div>
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
      <article className="mat-leather rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.22)] p-[var(--s5)]">
        <p className="t-eyebrow">Revenue Operations</p>
        <h2 className="t-command mt-[var(--s3)]">Revenue & Funding Center</h2>
        <p className="t-body mt-[var(--s3)]">
          Front-end control surface for memberships, donations, sponsors, B2B accounts, wholesale accounts, grants, scholarships, and funding workflows.
        </p>
        {/* The console-wide declaration, above the summary strip rather than
            inside a tab, because the strip is the part that is read at a glance
            and copied without opening anything: "Memberships 2", "Grants 1",
            "Scholarships 1" are hardcoded literals in summaryStrip, not counts
            of any record. Whoever transcribes those tiles into a board minute
            has invented the organisation's roster and grant load without ever
            clicking a tab. Same stamp and same shape as the per-tab notices
            below, and the same reason as FloorOperationsDesk.tsx putting its
            declaration in the header instead of over each panel. */}
        <p className="mt-[var(--s4)]"><span className="stamp stamp--brass stamp--flat">Planned — Not Yet Implemented</span></p>
        <p className="t-body mt-[var(--s3)]">
          Every row on every tab of this screen is fabricated sample data, and the counts in the
          strip below are hardcoded numbers written to match those rows — they are not counts of
          your organisation&apos;s records. This screen performs no fetch: nothing on it reads or writes
          a stored record. The one exception is Donations, which counts only what you type into this
          browser tab; that is held in the tab and nowhere else, and is gone on reload.
        </p>
        {/* Motto strip removed; see the note in AthleteWorkspace.tsx. It was
            least at home here of the four -- a grant officer reading a funding
            surface is not the audience for the gym's training motto. */}
        <div className="mt-4 flex flex-wrap gap-2">
          <Link
            href="/help#revenue-guide"
            className="btn btn--ghost"
          >
            HOW THIS WORKS
          </Link>
          <Link
            href="/help#planned-capabilities-guide"
            className="btn btn--ghost"
          >
            Planned Systems
          </Link>
        </div>
      </article>

      <section className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s4)]">
        <p className="t-eyebrow">Mission Funding Mindset</p>
        <p className="t-body mt-[var(--s2)]">Every dollar supports discipline, safety, and long-term growth. Keep the work clean, accountable, and purpose-driven.</p>
      </section>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {summaryStrip.map((item) => (
          <article key={item.label} className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s4)]">
            <p className="t-eyebrow">{item.label}</p>
            <p className="t-command mt-[var(--s3)]">{item.value}</p>
          </article>
        ))}
      </section>

      <section className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s4)]">
        <h3 className="t-command">Action Center</h3>
        <p className="t-body mt-[var(--s2)]">Triage these items first to keep operations moving.</p>
        <div className="mt-3 grid gap-2">
          {urgentActions.length === 0 ? (
            <p className="mat-leather rounded-[var(--r-md)] px-[var(--s4)] py-[var(--s4)] t-body">No urgent actions right now.</p>
          ) : (
            urgentActions.map((item) => (
              <button
                key={`urgent-${item.id}`}
                type="button"
                onClick={() => setActiveTab('treasurer-review')}
                className="btn btn--ghost w-full justify-between"
              >
                <span className="t-command">{item.title}</span>
                <span className={`border px-2 py-1 text-xs font-semibold ${statusTone(item.status)}`}>{item.status}</span>
              </button>
            ))
          )}
        </div>
      </section>

      <details className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s4)]">
        <summary className="cursor-pointer t-command">Capability Visibility (Revenue)</summary>
        <div className="mt-2">
        <p className="t-body mt-[var(--s2)]">Status map is front-end only and intended to improve discoverability and roadmap clarity.</p>
        <div className="mt-3 grid gap-2 md:grid-cols-2">
          {revenueCapabilities.map((item) => (
            <article key={item.capability} className={`border p-3 ${capabilityBadgeTone(item.state)}`}>
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-bold uppercase tracking-[0.06em]">{item.capability}</p>
                <span className="mat-leather rounded-[var(--r-sm)] px-[var(--s3)] py-[var(--s1)] t-data uppercase">{item.state}</span>
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
                  className="btn btn--ghost mt-[var(--s3)]"
                >
                  Open Capability
                </button>
              ) : (
                <button
                  type="button"
                  disabled
                  className="btn btn--ghost mt-[var(--s3)] cursor-not-allowed opacity-60 grayscale"
                >
                  Planned Capability
                </button>
              )}
            </article>
          ))}
        </div>
        </div>
      </details>

      <section className="flex flex-wrap gap-[var(--s3)] mat-leather rounded-[var(--r-md)] p-[var(--s3)]">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActiveTab(tab.id)}
            className={`min-h-[44px] border px-4 text-[length:var(--t-sm)] font-bold ${
              activeTab === tab.id
                ? 'mat-brass--patina border-[color:var(--brass-600)] text-[color:var(--hide-950)]'
                : 'border-[color:rgba(212,175,74,.28)] text-[color:var(--bone-300)] hover:border-[color:var(--brass-400)]'
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
              <div className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s4)]">
                <p className="t-command">Operational Revenue</p>
                <ul className="mt-2 space-y-1 text-base">
                  <li>Memberships</li>
                  <li>Products / Equipment</li>
                  <li>Wholesale Accounts</li>
                  <li>B2B Accounts</li>
                </ul>
              </div>
              <div className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s4)]">
                <p className="t-command">Philanthropic / Nonprofit Funding</p>
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
                <div key={item.id} className="flex flex-wrap items-center justify-between gap-[var(--s4)] mat-leather rounded-[var(--r-md)] p-[var(--s4)]">
                  <div>
                    <p className="t-command">{item.title}</p>
                    <p className="t-body">{item.revenueType} | {item.amountPlaceholder}</p>
                  </div>
                  <span className={`border px-2 py-1 text-[length:var(--t-sm)] font-semibold ${statusTone(item.status)}`}>{item.status}</span>
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
            <FabricatedRowsNotice
              rows="membership"
              realRecords="Your organisation's real memberships are stored records and are administered at /admin/memberships: one row per athlete per program, with its status, start date and scholarship discount."
              href="/admin/memberships"
              linkLabel="Open the real membership records"
            />
            {membershipRows.map((row) => (
              <div key={row.join('|')} className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s4)]">
                <p className="t-command">{row[0]}</p>
                <p className="t-body">{row[1]} | Membership Type: {row[2]} | Amount Placeholder: {row[3]}</p>
                <p className="mt-1 text-base">Status: {row[4]} | Start Date: {row[5]}</p>
                <p className="mt-1 text-base">Notes: {row[6]} | Admin Review Needed: {row[7]}</p>
              </div>
            ))}
            <p className="t-body">Membership types: Youth Athlete, Adult Fitness, Competition Track, Adaptive Training, Family Membership, Scholarship / Waived, Custom.</p>
          </div>
        </SectionCard>
      )}

      {activeTab === 'donations' && (
        <SectionCard title="Donation Tracking">
          <div className="space-y-4">
            <div className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s4)]">
              <p className="t-command">Add Donation Entry</p>
              <p className="t-body mt-[var(--s2)]">Tracks donation intent and review status for operations and treasurer visibility.</p>

              <div className="mt-3 grid gap-3 md:grid-cols-2">
                <div>
                  <label htmlFor="donor-name" className="t-label mb-[var(--s2)] block">Donor Name</label>
                  <input
                    id="donor-name"
                    value={donorName}
                    onChange={(event) => setDonorName(event.target.value)}
                    className="input"
                  />
                </div>
                <div>
                  <label htmlFor="donation-amount" className="t-label mb-[var(--s2)] block">Amount (USD)</label>
                  <input
                    id="donation-amount"
                    type="number"
                    min="1"
                    step="0.01"
                    value={donationAmount}
                    onChange={(event) => setDonationAmount(event.target.value)}
                    className="input"
                  />
                </div>
                <div>
                  <label htmlFor="donation-frequency" className="t-label mb-[var(--s2)] block">Frequency</label>
                  <select
                    id="donation-frequency"
                    value={donationFrequency}
                    onChange={(event) => setDonationFrequency(event.target.value as DonationFrequency)}
                    className="input"
                  >
                    <option value="One-Time">One-Time</option>
                    <option value="Monthly">Monthly</option>
                    <option value="Quarterly">Quarterly</option>
                    <option value="Annual">Annual</option>
                  </select>
                </div>
                <div>
                  <label htmlFor="donation-designation" className="t-label mb-[var(--s2)] block">Designation</label>
                  <input
                    id="donation-designation"
                    value={donationDesignation}
                    onChange={(event) => setDonationDesignation(event.target.value)}
                    className="input"
                  />
                </div>
                <div className="md:col-span-2">
                  <label htmlFor="donation-notes" className="t-label mb-[var(--s2)] block">Notes</label>
                  <textarea
                    id="donation-notes"
                    value={donationNotes}
                    onChange={(event) => setDonationNotes(event.target.value)}
                    className="textarea min-h-[89px]"
                  />
                </div>
                <label className="t-body flex items-center gap-[var(--s3)] md:col-span-2">
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
                  className="btn"
                >
                  Add Donation
                </button>
                <button
                  type="button"
                  onClick={resetDonationForm}
                  className="btn btn--ghost"
                >
                  Reset
                </button>
              </div>
            </div>

            <div className="space-y-3">
              {donationRecords.length === 0 && (
                <div className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s4)]">
                  <p className="text-base font-semibold">No donations are recorded.</p>
                  <p className="mt-1 text-base">
                    This platform holds no financial records. Donations, grants and fees live in the
                    gym&apos;s own books until a payment processor is connected.
                  </p>
                </div>
              )}
              {donationRecords.map((row) => (
                <div key={row.id} className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s4)]">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="t-command">{row.donorName}</p>
                      <p className="text-base">Designation: {row.designation} | Amount: {formatCurrency(row.amount)} | Frequency: {row.frequency}</p>
                      <p className="text-base">Receipt Needed: {row.receiptNeeded ? 'Yes' : 'No'} | Added: {row.createdAt}</p>
                      <p className="text-base">Notes: {row.notes}</p>
                    </div>
                    <div className="space-y-2">
                      <span className={`inline-block border px-2 py-1 text-[length:var(--t-sm)] font-semibold ${statusTone(row.status)}`}>{row.status}</span>
                      <select
                        value={row.status}
                        onChange={(event) => updateDonationStatus(row.id, event.target.value as DonationLifecycleStatus)}
                        className="input"
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

            <p className="t-body">Donation types supported in this lane: General Donation, Youth Program Support, Equipment Support, Scholarship Support, Facility Support, Event Support.</p>
            <p className="mat-leather rounded-[var(--r-md)] border border-[color:rgba(212,175,74,.24)] p-[var(--s4)] t-body">Operational tracking only. Payment processing and tax receipt issuance still require backend integration.</p>
          </div>
        </SectionCard>
      )}

      {activeTab === 'sponsors' && (
        <SectionCard title="Sponsor Tracking">
          <div className="space-y-3">
            {sponsorRows.map((row) => (
              <div key={row.join('|')} className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s4)]">
                <p className="t-command">{row[0]}</p>
                <p className="text-base">Contact: {row[1]} | Sponsor Type: {row[2]} | Support Type: {row[3]}</p>
                <p className="text-base">Program Supported: {row[4]} | Status: {row[5]} | Renewal Date: {row[6]}</p>
                <p className="text-base">Notes: {row[7]}</p>
              </div>
            ))}
            <p className="t-body">Sponsor types: Local Business, Community Partner, Veteran Organization, School Partner, Event Sponsor, Equipment Sponsor, General Sponsor.</p>
            <p className="t-body">Support types: Financial, Equipment, Services, Facility, Event Support, Volunteer Support.</p>
          </div>
        </SectionCard>
      )}

      {activeTab === 'b2b' && (
        <SectionCard title="B2B Account Tracking">
          <div className="space-y-3">
            {b2bRows.map((row) => (
              <div key={row.join('|')} className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s4)]">
                <p className="t-command">{row[0]}</p>
                <p className="text-base">Contact: {row[1]} | Account Type: {row[2]} | Lead Status: {row[3]}</p>
                <p className="text-base">Program Interest: {row[4]} | Estimated Value Placeholder: {row[5]}</p>
                <p className="text-base">Contract / Agreement: {row[6]} | Next Step: {row[7]}</p>
                <p className="text-base">Notes: {row[8]}</p>
              </div>
            ))}
            <p className="t-body">B2B account types: School, Youth Agency, Municipality, Veterans Organization, Community Organization, Corporate Wellness, Partner Training Center, Athletic Club, Other.</p>
            <p className="t-body">Lead statuses: Lead, Contacted, Proposal Needed, Negotiating, Active, Inactive, Closed.</p>
          </div>
        </SectionCard>
      )}

      {activeTab === 'wholesale' && (
        <SectionCard title="Wholesale Account Tracking">
          <div className="space-y-3">
            {wholesaleRows.map((row) => (
              <div key={row.join('|')} className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s4)]">
                <p className="t-command">{row[0]}</p>
                <p className="text-base">Account Type: {row[1]} | Contact: {row[2]} | Product Interest: {row[3]}</p>
                <p className="text-base">Pricing Tier: {row[4]} | Minimum Order: {row[5]} | Status: {row[6]}</p>
                <p className="text-base">Notes: {row[7]}</p>
              </div>
            ))}
            <p className="t-body">Wholesale account types: Retail Partner, Club Partner, School Program, Training / Fitness Facility, Event Vendor, Fundraising Partner.</p>
            <p className="t-body">Statuses: Prospect, Active, Pending Review, Needs Quote, Inactive.</p>
          </div>
        </SectionCard>
      )}

      {activeTab === 'grants' && (
        <SectionCard title="Grant Pipeline Tracking">
          <div className="space-y-3">
            <FabricatedRowsNotice
              rows="grant"
              realRecords="Your organisation's real grant work is stored at /admin/grants: the obligation ledger, one row per report, deliverable, renewal or filing, with its funder, its due date and whether it is overdue."
              href="/admin/grants"
              linkLabel="Open the real grant records"
            />
            {grantRows.map((row) => (
              <div key={row.join('|')} className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s4)]">
                <p className="t-command">{row[0]}</p>
                <p className="text-base">Funder: {row[1]} | Program Area: {row[2]} | Amount Placeholder: {row[3]}</p>
                <p className="text-base">Status: {row[4]} | Due Date: {row[5]} | Restricted Purpose: {row[6]}</p>
                <p className="text-base">Reporting Required: {row[7]} | Notes: {row[8]}</p>
              </div>
            ))}
            <p className="t-body">Program areas: Youth Development, Fitness / Wellness, Veteran-Owned Community Work, Facility, Equipment, Technology, Safety, Education, Adaptive Training.</p>
          </div>
        </SectionCard>
      )}

      {activeTab === 'scholarships' && (
        <SectionCard title="Scholarship Tracking">
          <div className="space-y-3">
            {/* No separate scholarship register exists to point at, and inventing
                one in this copy would be the same lie in a new place: a real
                scholarship IS a membership row carrying a discount percentage
                (see the header comment in app/admin/memberships/page.tsx -- 100%
                for a full scholarship, never a bypass of enrolment). So the door
                for this tab is the membership register, said out loud. */}
            <FabricatedRowsNotice
              rows="scholarship"
              realRecords="Your organisation keeps no separate scholarship table: a real scholarship is a stored discount percentage on a real membership row, so it is awarded and read at /admin/memberships alongside the membership it belongs to."
              href="/admin/memberships"
              linkLabel="Open the real scholarship records"
            />
            {scholarshipRows.map((row) => (
              <div key={row.join('|')} className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s4)]">
                <p className="t-command">{row[0]}</p>
                <p className="text-base">Support Type: {row[1]} | Amount Placeholder: {row[2]}</p>
                <p className="text-base">Sponsor / Funding Source: {row[3]} | Status: {row[4]} | Review Needed: {row[5]}</p>
                <p className="text-base">Notes: {row[6]}</p>
              </div>
            ))}
            <p className="t-body">Support types: Full Scholarship, Partial Scholarship, Participation Support Waiver, Equipment Assistance, Competition Participation Support, Travel Support, Program Support.</p>
            <p className="mat-leather rounded-[var(--r-md)] border border-[color:rgba(212,175,74,.24)] p-[var(--s4)] t-body">Scholarship tracking is for internal review only and does not expose private financial data to public users.</p>
          </div>
        </SectionCard>
      )}

      {activeTab === 'products' && (
        <SectionCard title="Products / Equipment Placeholder Catalog">
          <div className="space-y-3">
            {productRows.map((row) => (
              <div key={row.join('|')} className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s4)]">
                <p className="t-command">{row[0]}</p>
                <p className="text-base">Category: {row[1]} | Retail Price Placeholder: {row[2]} | Wholesale Price Placeholder: {row[3]}</p>
                <p className="text-base">Inventory Placeholder: {row[4]} | Status: {row[5]}</p>
                <p className="text-base">Notes: {row[6]}</p>
              </div>
            ))}
            <p className="t-body">Categories: Gloves, Wraps, Apparel, Training Gear, Club Packages, Fundraiser Items, Wholesale Bundles.</p>
            <p className="t-body">No cart, checkout, tax, or shipping logic is implemented in this front-end placeholder.</p>
          </div>
        </SectionCard>
      )}

      {activeTab === 'payment-settings' && (
        <SectionCard title="Payment Settings Placeholder">
          <div className="grid gap-3 md:grid-cols-2">
            {paymentIntegrations.map((integration) => (
              <article key={integration.provider} className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s4)]">
                <p className="t-command">{integration.provider}</p>
                <p className="t-body mt-[var(--s3)]">{integration.status}</p>
                <p className="t-body">{integration.notes}</p>
              </article>
            ))}
          </div>
          <p className="mat-leather rounded-[var(--r-md)] border border-[color:rgba(212,175,74,.24)] p-[var(--s4)] t-body mt-[var(--s4)]">No payment processor is connected. This application does not currently process real payments.</p>
        </SectionCard>
      )}

      {activeTab === 'treasurer-review' && (
        <SectionCard title="Membership Oversight Queue">
          <p className="text-base">Membership Oversight View - Future Board Integration.</p>
          <div className="mt-3 space-y-2">
            {treasurerQueue.map((item) => (
              <div key={item.join('|')} className="mat-leather rounded-[var(--r-md)] p-[var(--s4)]">
                <p className="t-command">{item[0]}</p>
                <p className="text-base">Category: {item[1]} | Status: {item[2]} | Review Needed: {item[3]}</p>
                <p className="text-base">Notes: {item[4]}</p>
              </div>
            ))}
            {donationRecords
              .filter((item) => item.status === 'Pending Review' || item.status === 'Pledged')
              .map((item) => (
                <div key={`treasurer-${item.id}`} className="mat-leather rounded-[var(--r-md)] p-[var(--s4)]">
                  <p className="t-command">Donation Review - {item.donorName}</p>
                  <p className="text-base">Category: Donations | Status: {item.status} | Review Needed: Yes</p>
                  <p className="text-base">Amount: {formatCurrency(item.amount)} | Designation: {item.designation}</p>
                </div>
              ))}
          </div>
        </SectionCard>
      )}

      <section className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s5)]">
        <h3 className="t-command">Compliance Boundary</h3>
        <p className="t-body mt-[var(--s3)]">
          Front-end planning tool only. This screen does not process payments, issue receipts, create invoices, calculate taxes, store card data, or provide legal/financial advice.
        </p>
      </section>

      <details className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s4)]">
        <summary className="cursor-pointer t-command">Local Placeholder Data Structures</summary>
        <div className="t-body mt-[var(--s3)] space-y-[var(--s2)]">
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

