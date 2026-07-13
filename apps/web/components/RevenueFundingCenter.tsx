'use client';

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

interface PaymentIntegrationPlaceholder {
  provider: string;
  status: 'Not Connected';
  connected: false;
  notes: string;
  futureBackendRequired: true;
}

const summaryStrip = [
  { label: 'Memberships', value: 0 },
  { label: 'Donations', value: 0 },
  { label: 'Sponsors', value: 0 },
  { label: 'B2B Accounts', value: 0 },
  { label: 'Wholesale Accounts', value: 0 },
  { label: 'Grants', value: 0 },
  { label: 'Scholarships', value: 0 },
  { label: 'Pending Reviews', value: 0 },
];

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

function statusTone(status: string): string {
  const normalized = status.toLowerCase();
  if (normalized.includes('active') || normalized.includes('received') || normalized.includes('awarded')) {
    return 'text-[#e8d7c6] border-[#8b4444] bg-[#2b1a12]';
  }
  if (normalized.includes('pending') || normalized.includes('review') || normalized.includes('draft') || normalized.includes('submitted')) {
    return 'text-[#d4a574] border-[#694838] bg-[#101010]';
  }
  if (normalized.includes('past due') || normalized.includes('declined') || normalized.includes('not connected')) {
    return 'text-[#e8d7c6] border-[#8b4444] bg-[#2f1717]';
  }
  return 'text-[#cfbfae] border-[#4a3a2a] bg-[#171515]';
}

function SectionCard({ title, children }: Readonly<{ title: string; children: React.ReactNode }>) {
  return (
    <section className="border border-[#3a3a3a] bg-[#161616] p-5">
      <h3 className="text-lg font-bold text-[#f2e7da]">{title}</h3>
      <div className="mt-3 text-base text-[#cfbfae]">{children}</div>
    </section>
  );
}

export default function RevenueFundingCenter() {
  const [activeTab, setActiveTab] = useState<RevenueFundingTab>('overview');

  const pendingItems = useMemo(() => revenueItems.filter((item) => item.reviewNeeded), []);

  const membershipRows = [
    ['Member Name Placeholder', 'Family / Guardian Placeholder', 'Youth Athlete', '$0.00', 'Pending', 'Start Date Placeholder', 'No card data stored.', 'Yes'],
    ['Member Name Placeholder', 'Family / Guardian Placeholder', 'Scholarship / Waived', '$0.00', 'Scholarship', 'Start Date Placeholder', 'Review scholarship lane.', 'Yes'],
  ];

  const donationRows = [
    ['Donor Name Placeholder', 'General Donation', '$0.00', 'One-Time Placeholder', 'Unrestricted Placeholder', 'General Donation', 'Receipt Needed Placeholder', 'Pledged / Pending Review', 'No receipts issued here.'],
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
      <article className="border-2 border-[#8b4444] bg-[#151515] p-6">
        <p className="text-[14px] font-mono uppercase tracking-[0.14em] text-[#d4a574]">Revenue Operations</p>
        <h2 className="mt-2 text-[34px] font-black text-[#f2e7da]">Revenue & Funding Center</h2>
        <p className="mt-3 text-base leading-7 text-[#cfbfae]">
          Front-end control surface for memberships, donations, sponsors, B2B accounts, wholesale accounts, grants, scholarships, and funding workflows.
        </p>
      </article>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {summaryStrip.map((item) => (
          <article key={item.label} className="border border-[#3a3a3a] bg-[#161616] px-4 py-4">
            <p className="text-[14px] font-mono uppercase tracking-[0.1em] text-[#d4a574]">{item.label}</p>
            <p className="mt-2 text-[30px] font-black text-[#f2e7da]">{item.value}</p>
          </article>
        ))}
      </section>

      <section className="flex flex-wrap gap-2 border border-[#3a3a3a] bg-[#121212] p-2">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActiveTab(tab.id)}
            className={`min-h-[44px] border px-4 text-[14px] font-bold ${
              activeTab === tab.id
                ? 'border-[#8b4444] bg-[#5a2a2a] text-[#f2e7da]'
                : 'border-[#3a3a3a] bg-[#1a1a1a] text-[#cfbfae] hover:border-[#8b4444]'
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
              <div className="border border-[#3a3a3a] bg-[#101010] p-4">
                <p className="text-lg font-bold text-[#f2e7da]">Operational Revenue</p>
                <ul className="mt-2 space-y-1 text-base">
                  <li>Memberships</li>
                  <li>Products / Equipment</li>
                  <li>Wholesale Accounts</li>
                  <li>B2B Accounts</li>
                </ul>
              </div>
              <div className="border border-[#3a3a3a] bg-[#101010] p-4">
                <p className="text-lg font-bold text-[#f2e7da]">Philanthropic / Nonprofit Funding</p>
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
                <div key={item.id} className="flex flex-wrap items-center justify-between gap-3 border border-[#3a3a3a] bg-[#101010] p-3">
                  <div>
                    <p className="text-base font-semibold text-[#f2e7da]">{item.title}</p>
                    <p className="text-[14px] text-[#bfb3a6]">{item.revenueType} | {item.amountPlaceholder}</p>
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
              <div key={row.join('|')} className="border border-[#3a3a3a] bg-[#101010] p-4">
                <p className="text-lg font-bold text-[#f2e7da]">{row[0]}</p>
                <p className="text-[14px] text-[#bfb3a6]">{row[1]} | Membership Type: {row[2]} | Amount Placeholder: {row[3]}</p>
                <p className="mt-1 text-base">Status: {row[4]} | Start Date: {row[5]}</p>
                <p className="mt-1 text-base">Notes: {row[6]} | Admin Review Needed: {row[7]}</p>
              </div>
            ))}
            <p className="text-[14px] text-[#cfbfae]">Membership types: Youth Athlete, Adult Fitness, Competition Track, Adaptive Training, Family Membership, Scholarship / Waived, Custom.</p>
          </div>
        </SectionCard>
      )}

      {activeTab === 'donations' && (
        <SectionCard title="Donation Tracking">
          <div className="space-y-3">
            {donationRows.map((row) => (
              <div key={row.join('|')} className="border border-[#3a3a3a] bg-[#101010] p-4">
                <p className="text-lg font-bold text-[#f2e7da]">{row[0]}</p>
                <p className="text-base">Type: {row[1]} | Amount Placeholder: {row[2]} | One-Time / Recurring: {row[3]}</p>
                <p className="text-base">Restricted / Unrestricted: {row[4]} | Program Designation: {row[5]}</p>
                <p className="text-base">Receipt Needed: {row[6]} | Status: {row[7]}</p>
                <p className="text-base">Notes: {row[8]}</p>
              </div>
            ))}
            <p className="text-[14px] text-[#cfbfae]">Donation types: General Donation, Youth Program Support, Equipment Support, Scholarship Support, Facility Support, Event Support, Memorial / Honorary Placeholder.</p>
            <p className="border border-[#8b4444] bg-[#2b1a12] p-3 text-[14px] text-[#d4a574]">Front-end tracking only. This does not process donations or issue tax receipts.</p>
          </div>
        </SectionCard>
      )}

      {activeTab === 'sponsors' && (
        <SectionCard title="Sponsor Tracking">
          <div className="space-y-3">
            {sponsorRows.map((row) => (
              <div key={row.join('|')} className="border border-[#3a3a3a] bg-[#101010] p-4">
                <p className="text-lg font-bold text-[#f2e7da]">{row[0]}</p>
                <p className="text-base">Contact: {row[1]} | Sponsor Type: {row[2]} | Support Type: {row[3]}</p>
                <p className="text-base">Program Supported: {row[4]} | Status: {row[5]} | Renewal Date: {row[6]}</p>
                <p className="text-base">Notes: {row[7]}</p>
              </div>
            ))}
            <p className="text-[14px] text-[#cfbfae]">Sponsor types: Local Business, Community Partner, Veteran Organization, School Partner, Event Sponsor, Equipment Sponsor, General Sponsor.</p>
            <p className="text-[14px] text-[#cfbfae]">Support types: Financial, Equipment, Services, Facility, Event Support, Volunteer Support.</p>
          </div>
        </SectionCard>
      )}

      {activeTab === 'b2b' && (
        <SectionCard title="B2B Account Tracking">
          <div className="space-y-3">
            {b2bRows.map((row) => (
              <div key={row.join('|')} className="border border-[#3a3a3a] bg-[#101010] p-4">
                <p className="text-lg font-bold text-[#f2e7da]">{row[0]}</p>
                <p className="text-base">Contact: {row[1]} | Account Type: {row[2]} | Lead Status: {row[3]}</p>
                <p className="text-base">Program Interest: {row[4]} | Estimated Value Placeholder: {row[5]}</p>
                <p className="text-base">Contract / Agreement: {row[6]} | Next Step: {row[7]}</p>
                <p className="text-base">Notes: {row[8]}</p>
              </div>
            ))}
            <p className="text-[14px] text-[#cfbfae]">B2B account types: School, Youth Agency, Municipality, Veterans Organization, Community Organization, Corporate Wellness, Partner Training Center, Athletic Club, Other.</p>
            <p className="text-[14px] text-[#cfbfae]">Lead statuses: Lead, Contacted, Proposal Needed, Negotiating, Active, Inactive, Closed.</p>
          </div>
        </SectionCard>
      )}

      {activeTab === 'wholesale' && (
        <SectionCard title="Wholesale Account Tracking">
          <div className="space-y-3">
            {wholesaleRows.map((row) => (
              <div key={row.join('|')} className="border border-[#3a3a3a] bg-[#101010] p-4">
                <p className="text-lg font-bold text-[#f2e7da]">{row[0]}</p>
                <p className="text-base">Account Type: {row[1]} | Contact: {row[2]} | Product Interest: {row[3]}</p>
                <p className="text-base">Pricing Tier: {row[4]} | Minimum Order: {row[5]} | Status: {row[6]}</p>
                <p className="text-base">Notes: {row[7]}</p>
              </div>
            ))}
            <p className="text-[14px] text-[#cfbfae]">Wholesale account types: Retail Partner, Club Partner, School Program, Training / Fitness Facility, Event Vendor, Fundraising Partner.</p>
            <p className="text-[14px] text-[#cfbfae]">Statuses: Prospect, Active, Pending Review, Needs Quote, Inactive.</p>
          </div>
        </SectionCard>
      )}

      {activeTab === 'grants' && (
        <SectionCard title="Grant Pipeline Tracking">
          <div className="space-y-3">
            {grantRows.map((row) => (
              <div key={row.join('|')} className="border border-[#3a3a3a] bg-[#101010] p-4">
                <p className="text-lg font-bold text-[#f2e7da]">{row[0]}</p>
                <p className="text-base">Funder: {row[1]} | Program Area: {row[2]} | Amount Placeholder: {row[3]}</p>
                <p className="text-base">Status: {row[4]} | Due Date: {row[5]} | Restricted Purpose: {row[6]}</p>
                <p className="text-base">Reporting Required: {row[7]} | Notes: {row[8]}</p>
              </div>
            ))}
            <p className="text-[14px] text-[#cfbfae]">Program areas: Youth Development, Fitness / Wellness, Veteran-Owned Community Work, Facility, Equipment, Technology, Safety, Education, Adaptive Training.</p>
          </div>
        </SectionCard>
      )}

      {activeTab === 'scholarships' && (
        <SectionCard title="Scholarship Tracking">
          <div className="space-y-3">
            {scholarshipRows.map((row) => (
              <div key={row.join('|')} className="border border-[#3a3a3a] bg-[#101010] p-4">
                <p className="text-lg font-bold text-[#f2e7da]">{row[0]}</p>
                <p className="text-base">Support Type: {row[1]} | Amount Placeholder: {row[2]}</p>
                <p className="text-base">Sponsor / Funding Source: {row[3]} | Status: {row[4]} | Review Needed: {row[5]}</p>
                <p className="text-base">Notes: {row[6]}</p>
              </div>
            ))}
            <p className="text-[14px] text-[#cfbfae]">Support types: Full Scholarship, Partial Scholarship, Participation Support Waiver, Equipment Assistance, Competition Participation Support, Travel Support, Program Support.</p>
            <p className="border border-[#8b4444] bg-[#2b1a12] p-3 text-[14px] text-[#d4a574]">Scholarship tracking is for internal review only and does not expose private financial data to public users.</p>
          </div>
        </SectionCard>
      )}

      {activeTab === 'products' && (
        <SectionCard title="Products / Equipment Placeholder Catalog">
          <div className="space-y-3">
            {productRows.map((row) => (
              <div key={row.join('|')} className="border border-[#3a3a3a] bg-[#101010] p-4">
                <p className="text-lg font-bold text-[#f2e7da]">{row[0]}</p>
                <p className="text-base">Category: {row[1]} | Retail Price Placeholder: {row[2]} | Wholesale Price Placeholder: {row[3]}</p>
                <p className="text-base">Inventory Placeholder: {row[4]} | Status: {row[5]}</p>
                <p className="text-base">Notes: {row[6]}</p>
              </div>
            ))}
            <p className="text-[14px] text-[#cfbfae]">Categories: Gloves, Wraps, Apparel, Training Gear, Club Packages, Fundraiser Items, Wholesale Bundles.</p>
            <p className="text-[14px] text-[#cfbfae]">No cart, checkout, tax, or shipping logic is implemented in this front-end placeholder.</p>
          </div>
        </SectionCard>
      )}

      {activeTab === 'payment-settings' && (
        <SectionCard title="Payment Settings Placeholder">
          <div className="grid gap-3 md:grid-cols-2">
            {paymentIntegrations.map((integration) => (
              <article key={integration.provider} className="border border-[#8b4444] bg-[#2f1717] p-4">
                <p className="text-lg font-bold text-[#f2e7da]">{integration.provider}</p>
                <p className="mt-2 text-base text-[#d4a574]">{integration.status}</p>
                <p className="text-[14px] text-[#cfbfae]">{integration.notes}</p>
              </article>
            ))}
          </div>
          <p className="mt-4 border border-[#8b4444] bg-[#2f1717] p-3 text-[14px] text-[#d4a574]">No payment processor is connected. This application does not currently process real payments.</p>
        </SectionCard>
      )}

      {activeTab === 'treasurer-review' && (
        <SectionCard title="Membership Oversight Queue">
          <p className="text-base">Membership Oversight View - Future Board Integration.</p>
          <div className="mt-3 space-y-2">
            {treasurerQueue.map((item) => (
              <div key={item.join('|')} className="border border-[#3a3a3a] bg-[#101010] p-3">
                <p className="text-lg font-semibold text-[#f2e7da]">{item[0]}</p>
                <p className="text-base">Category: {item[1]} | Status: {item[2]} | Review Needed: {item[3]}</p>
                <p className="text-base">Notes: {item[4]}</p>
              </div>
            ))}
          </div>
        </SectionCard>
      )}

      <section className="border-2 border-[#8b4444] bg-[#1a1a1a] p-5">
        <h3 className="text-lg font-bold text-[#f2e7da]">Compliance Boundary</h3>
        <p className="mt-2 text-base leading-7 text-[#cfbfae]">
          Front-end planning tool only. This screen does not process payments, issue receipts, create invoices, calculate taxes, store card data, or provide legal/financial advice.
        </p>
      </section>

      <details className="border border-[#3a3a3a] bg-[#141414] p-4">
        <summary className="cursor-pointer text-base font-semibold text-[#f2e7da]">Local Placeholder Data Structures</summary>
        <div className="mt-3 space-y-2 text-[14px] text-[#cfbfae]">
          <p>RevenueAccount: id, name, accountType, contactName, emailPlaceholder, phonePlaceholder, category, status, assignedOwner, notes, createdAt, updatedAt.</p>
          <p>RevenueItem: id, title, revenueType, amountPlaceholder, status, relatedAccountId, restrictedPurpose, reviewNeeded, notes.</p>
          <p>PaymentIntegrationPlaceholder: provider, status, connected, notes, futureBackendRequired.</p>
          <p>Loaded Accounts: {revenueAccounts.length} | Loaded Items: {revenueItems.length} | Loaded Integrations: {paymentIntegrations.length}</p>
        </div>
      </details>
    </section>
  );
}

