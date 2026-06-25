import CoachReviewQueue from '../components/CoachReviewQueue';

export default function Home() {
  return (
    <div>
      <h1 className="text-4xl font-bold p-8">PPBF Platform</h1>
      <div className="px-8 pb-6">
        <a
          href="/admin"
          style={{
            display: 'inline-block',
            padding: '10px 14px',
            borderRadius: '8px',
            background: '#111',
            color: 'white',
            textDecoration: 'none',
          }}
        >
          Open Admin Capabilities
        </a>
      </div>
      <CoachReviewQueue />
    </div>
  );
}
