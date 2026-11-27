/*
 * Types for web-push 3.6.7 (QD (a) on #2228: exact pin), which ships none.
 * Only the one function the push sender calls is declared (lane W5-WP: the
 * sender, WP-2b-2b; the transport's test, WP-2b-2a). It builds a push request
 * -- the payload encrypted to the browser's keys, the VAPID Authorization
 * header, TTL, Urgency and Topic -- and sends nothing; the sender posts it
 * itself (src/web-push-lib.js, generateRequestDetails; pushTransport.ts).
 */
declare module 'web-push' {
  export interface PushRequestDetails {
    readonly method: string;
    readonly headers: Record<string, string | number>;
    readonly body: Buffer | null;
    readonly endpoint: string;
  }

  export function generateRequestDetails(
    subscription: { readonly endpoint: string; readonly keys: { readonly p256dh: string; readonly auth: string } },
    payload: string | null,
    options: {
      readonly vapidDetails: { readonly subject: string; readonly publicKey: string; readonly privateKey: string };
      readonly TTL: number;
      readonly urgency: 'very-low' | 'low' | 'normal' | 'high';
      readonly topic: string;
    },
  ): PushRequestDetails;
}
