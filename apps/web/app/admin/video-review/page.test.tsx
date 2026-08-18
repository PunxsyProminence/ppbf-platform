/**
 * @jest-environment jsdom
 */

import type { ReactNode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import VideoReviewManagementPage from './page';
import { getRoleSessionSnapshot } from '@/components/roleSession';

jest.mock('@/components/RoleSessionGate', () => ({
  __esModule: true,
  default: ({ children }: { readonly children: ReactNode }) => children,
}));

jest.mock('@/components/roleSession', () => ({
  ...jest.requireActual('@/components/roleSession'),
  getRoleSessionSnapshot: jest.fn(),
}));

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href }: { readonly children: ReactNode; readonly href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

const mockGetRoleSessionSnapshot = getRoleSessionSnapshot as jest.Mock;
const originalFetch = global.fetch;

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as Response;
}

afterEach(() => {
  global.fetch = originalFetch;
  jest.clearAllMocks();
});

describe('VideoReviewManagementPage', () => {
  it('renders WrongRoleNotice for platform_owner role', async () => {
    mockGetRoleSessionSnapshot.mockReturnValue({ role: 'platform_owner', expiresAt: Date.now() + 10000 });
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<VideoReviewManagementPage />);

    expect(screen.getByText('Video review escalation is managed per gym')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Platform console' }).getAttribute('href')).toBe('/admin/platform');
  });

  it('renders quarantined videos list for organization admin', async () => {
    mockGetRoleSessionSnapshot.mockReturnValue({ role: 'admin', expiresAt: Date.now() + 10000 });

    const videoItems = [
      {
        video_session_id: 'vid-101',
        title: 'Sparring Drill 1',
        notes: 'Needs review',
        file_name: 'clip.mp4',
        file_size_bytes: 1048576,
        mime_type: 'video/mp4',
        status: 'quarantined',
        scan_state: 'needs_human_review',
        athlete_id: 'ath-001',
        uploaded_by_account_id: 'coach-1',
        created_at: '2026-08-01T12:00:00Z',
      },
    ];

    const fetchMock = jest.fn(async (url: string) => {
      if (String(url).includes('/api/pilot/video/list')) {
        return jsonResponse({ items: videoItems });
      }
      return jsonResponse({ ok: true });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<VideoReviewManagementPage />);

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/api/pilot/video/list'),
        expect.objectContaining({ method: 'GET' }),
      ),
    );

    expect(screen.getByText('Quarantined Video Review Escalation')).toBeTruthy();
    expect(await screen.findByText('Sparring Drill 1')).toBeTruthy();
    expect(screen.getByText('ID: vid-101')).toBeTruthy();
  });

  it('requests temporary review link when Inspect / Watch Video is clicked', async () => {
    mockGetRoleSessionSnapshot.mockReturnValue({ role: 'admin', expiresAt: Date.now() + 10000 });

    const videoItems = [
      {
        video_session_id: 'vid-101',
        title: 'Sparring Drill 1',
        notes: 'Needs review',
        file_name: 'clip.mp4',
        file_size_bytes: 1048576,
        mime_type: 'video/mp4',
        status: 'quarantined',
        scan_state: 'needs_human_review',
        athlete_id: 'ath-001',
        uploaded_by_account_id: 'coach-1',
        created_at: '2026-08-01T12:00:00Z',
      },
    ];

    const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/api/pilot/video/list')) {
        return jsonResponse({ items: videoItems });
      }
      if (String(url).includes('/api/pilot/video/review-link') && init?.method === 'POST') {
        return jsonResponse({
          ok: true,
          video_session_id: 'vid-101',
          url: 'https://blob.example.com/stream?sas=token',
          scan_detail: 'Sensitive content scan flagged for review',
          expires_in_minutes: 15,
        });
      }
      return jsonResponse({ ok: true });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<VideoReviewManagementPage />);

    const inspectBtn = await screen.findByRole('button', { name: 'Inspect / Watch Video' });
    fireEvent.click(inspectBtn);

    expect(await screen.findByText('Temporary Inspection Link Active (15m TTL)')).toBeTruthy();
    expect(
      screen.getByText('Automated Scanner Detail: Sensitive content scan flagged for review'),
    ).toBeTruthy();
  });

  it('submits approve decision to scan-review route', async () => {
    mockGetRoleSessionSnapshot.mockReturnValue({ role: 'admin', expiresAt: Date.now() + 10000 });

    const videoItems = [
      {
        video_session_id: 'vid-101',
        title: 'Sparring Drill 1',
        notes: 'Needs review',
        file_name: 'clip.mp4',
        file_size_bytes: 1048576,
        mime_type: 'video/mp4',
        status: 'quarantined',
        scan_state: 'needs_human_review',
        athlete_id: 'ath-001',
        uploaded_by_account_id: 'coach-1',
        created_at: '2026-08-01T12:00:00Z',
      },
    ];

    const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/api/pilot/video/list')) {
        return jsonResponse({ items: videoItems });
      }
      if (String(url).includes('/api/pilot/video/review-link') && init?.method === 'POST') {
        return jsonResponse({ ok: true, url: 'https://blob.example.com/s?sas=t', expires_in_minutes: 15 });
      }
      if (String(url).includes('/api/pilot/video/scan-review') && init?.method === 'POST') {
        return jsonResponse({
          ok: true,
          video_session_id: 'vid-101',
          decision: 'approve',
          status: 'ready',
          scan_state: 'cleared',
        });
      }
      return jsonResponse({ ok: true });
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(true);

    render(<VideoReviewManagementPage />);

    // Approve now requires the reviewer to have opened the footage first, so the
    // happy path has to inspect before it can decide.
    fireEvent.click(await screen.findByRole('button', { name: 'Inspect / Watch Video' }));
    await screen.findByText('Temporary Inspection Link Active (15m TTL)');

    const approveBtn = await screen.findByRole('button', { name: 'Approve Video (Set Ready)' });
    fireEvent.click(approveBtn);

    expect(
      await screen.findByText('✓ Video "vid-101" approved — status updated to ready.'),
    ).toBeTruthy();
    expect(confirmSpy).toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('refuses to approve a video the reviewer has not opened', async () => {
    mockGetRoleSessionSnapshot.mockReturnValue({ role: 'admin', expiresAt: Date.now() + 10000 });

    const fetchMock = jest.fn(async (url: string) => {
      if (String(url).includes('/api/pilot/video/list')) {
        return jsonResponse({
          items: [
            {
              video_session_id: 'vid-101',
              title: 'Sparring Drill 1',
              notes: 'Needs review',
              file_name: 'clip.mp4',
              file_size_bytes: 1048576,
              mime_type: 'video/mp4',
              status: 'quarantined',
              scan_state: 'needs_human_review',
              athlete_id: 'ath-001',
              uploaded_by_account_id: 'coach-1',
              created_at: '2026-08-01T12:00:00Z',
            },
          ],
        });
      }
      return jsonResponse({ ok: true });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<VideoReviewManagementPage />);

    const approveBtn = await screen.findByRole('button', { name: 'Approve Video (Set Ready)' });
    expect((approveBtn as HTMLButtonElement).disabled).toBe(true);
    // The reason is stated in words, not carried by the disabled styling alone.
    expect(screen.getByTestId('approve-gate-vid-101')).toBeTruthy();

    // And no decision request escapes even if the click lands.
    fireEvent.click(approveBtn);
    expect(
      fetchMock.mock.calls.filter((call) => String(call[0]).includes('/scan-review')),
    ).toHaveLength(0);
  });

  it('abandons the approval when the reviewer cancels the confirm', async () => {
    mockGetRoleSessionSnapshot.mockReturnValue({ role: 'admin', expiresAt: Date.now() + 10000 });

    const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/api/pilot/video/list')) {
        return jsonResponse({
          items: [
            {
              video_session_id: 'vid-101',
              title: 'Sparring Drill 1',
              notes: 'Needs review',
              file_name: 'clip.mp4',
              file_size_bytes: 1048576,
              mime_type: 'video/mp4',
              status: 'quarantined',
              scan_state: 'needs_human_review',
              athlete_id: 'ath-001',
              uploaded_by_account_id: 'coach-1',
              created_at: '2026-08-01T12:00:00Z',
            },
          ],
        });
      }
      if (String(url).includes('/api/pilot/video/review-link') && init?.method === 'POST') {
        return jsonResponse({ ok: true, url: 'https://blob.example.com/s?sas=t', expires_in_minutes: 15 });
      }
      return jsonResponse({ ok: true });
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(false);

    render(<VideoReviewManagementPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'Inspect / Watch Video' }));
    await screen.findByText('Temporary Inspection Link Active (15m TTL)');

    fireEvent.click(await screen.findByRole('button', { name: 'Approve Video (Set Ready)' }));

    expect(confirmSpy).toHaveBeenCalled();
    expect(
      fetchMock.mock.calls.filter((call) => String(call[0]).includes('/scan-review')),
    ).toHaveLength(0);
    confirmSpy.mockRestore();
  });

  it('submits block decision to scan-review route', async () => {
    mockGetRoleSessionSnapshot.mockReturnValue({ role: 'admin', expiresAt: Date.now() + 10000 });

    const videoItems = [
      {
        video_session_id: 'vid-102',
        title: 'Drill 2',
        notes: 'Flagged',
        file_name: 'clip2.mp4',
        file_size_bytes: 2048576,
        mime_type: 'video/mp4',
        status: 'quarantined',
        scan_state: 'blocked',
        athlete_id: 'ath-002',
        uploaded_by_account_id: 'coach-2',
        created_at: '2026-08-02T12:00:00Z',
      },
    ];

    const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/api/pilot/video/list')) {
        return jsonResponse({ items: videoItems });
      }
      if (String(url).includes('/api/pilot/video/scan-review') && init?.method === 'POST') {
        return jsonResponse({
          ok: true,
          video_session_id: 'vid-102',
          decision: 'block',
          status: 'quarantined',
          scan_state: 'blocked',
        });
      }
      return jsonResponse({ ok: true });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<VideoReviewManagementPage />);

    const blockBtn = await screen.findByRole('button', { name: 'Block Video (Keep Quarantined)' });
    fireEvent.click(blockBtn);

    expect(
      await screen.findByText('✓ Video "vid-102" blocked — status remains quarantined.'),
    ).toBeTruthy();
  });
});
