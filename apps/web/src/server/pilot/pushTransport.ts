/**
 * POSTS ONE WEB PUSH REQUEST, AND ONLY TO A PUBLIC ADDRESS (lane W5-WP,
 * WP-2b-2a; plan and GO on #2228, section 12's carry-forward from the
 * reviewers of #2231 and #2236).
 *
 * A push endpoint is whatever a browser handed the save route, so its host
 * may be anyone's. web-push 3.6.7 builds the request (the sender, WP-2b-2b) but
 * its own send parses the URL with url.parse, posts wherever that points, has
 * only an idle timeout and reads an answer of any length (src/web-push-lib.js).
 * So the request is posted here instead:
 *   - THE ADDRESS IT CONNECTS TO IS CHECKED, by the connection's own lookup
 *     (publicOnlyLookup), so no second lookup can hand it another address: a
 *     host that resolves to any private, loopback, link-local, shared,
 *     multicast, reserved, documentation or NAT64 address is refused, before
 *     any connection. An IPv4-mapped IPv6 address is judged by its IPv4 rules
 *     (net.BlockList does so; pushTransport.test.ts pins it). The endpoint's
 *     own shape (pilot.push_subscriptions' CHECK, parsePushEndpoint) already
 *     refuses an IP literal, a port and userinfo.
 *   - AN ADDRESS GIVEN AS THE HOST is refused outright: the connection never
 *     looks one up, so the check above could not see it.
 *   - NO SHARED AGENT (agent: false): a pooled socket or an environment proxy
 *     would connect without this lookup.
 *   - IT ALWAYS SETTLES. The whole request, lookup included, is cut off at the
 *     caller's time limit (PUSH_TIMEOUT) until the answer's status line
 *     arrives; an upgrade answer (101 with an Upgrade header, which never
 *     reaches the response callback) is refused (PUSH_BAD_STATUS); and a
 *     request that closes with nothing said is PUSH_NO_ANSWER. A post that
 *     never settled would hold up the whole worker tick (reviewer I on WP-2b-2a).
 *   - NONE OF AN ANSWER'S BODY IS READ: the status is all that is used, and the
 *     connection is closed with it. A status outside 100-599 (an HTTP client
 *     takes any three digits) is refused as PUSH_BAD_STATUS, so the send log's
 *     CHECK on last_status_code never sees one.
 */

import dns from 'node:dns';
import https from 'node:https';
import net, { type LookupFunction } from 'node:net';
import type { ClientRequest, IncomingMessage, RequestOptions } from 'node:http';

import type { PushRequestDetails } from 'web-push';

const NOT_PUBLIC = new net.BlockList();
for (const [prefix, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['168.63.129.16', 32], ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) NOT_PUBLIC.addSubnet(prefix, bits, 'ipv4');
// No ::ffff:0:0/96 rule: net.BlockList reads it as every IPv4 address too.
for (const [prefix, bits] of [
  ['::', 96], ['::1', 128], ['::ffff:0:0:0', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64],
  ['2001::', 32], ['2001:2::', 48], ['2001:10::', 28], ['2001:20::', 28], ['2001:db8::', 32], ['2002::', 16],
  ['3fff::', 20], ['5f00::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
] as const) NOT_PUBLIC.addSubnet(prefix, bits, 'ipv6');

/** Whether an address is one a push may be sent to. Anything that is not an IP address is not. */
export function isPublicAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 0) return false;
  return !NOT_PUBLIC.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

/** Why a push was not posted, or its answer not read; `code` goes to the send log. */
export class PushPostError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'PushPostError';
  }
}

type Resolve = (
  hostname: string,
  options: dns.LookupAllOptions,
  callback: (error: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[]) => void,
) => void;

/** A connection lookup that resolves every address and refuses the host if any one is not public. */
export function publicOnlyLookup(resolve: Resolve = dns.lookup): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname, { family: options.family, hints: options.hints, all: true }, (error, addresses) => {
      if (error) return callback(error, '', 0);
      if (addresses.length === 0 || !addresses.every((entry) => isPublicAddress(entry.address))) {
        return callback(new PushPostError('PUSH_HOST_NOT_PUBLIC'), '', 0);
      }
      if (options.all) return (callback as unknown as (e: null, all: dns.LookupAddress[]) => void)(null, addresses);
      return callback(null, addresses[0].address, addresses[0].family);
    });
  };
}

export interface PushPostOptions {
  readonly timeoutMs: number;
  readonly lookup: LookupFunction;
  /** https.request; a test may hand in http.request. */
  readonly request: (options: RequestOptions, onResponse: (response: IncomingMessage) => void) => ClientRequest;
}

export const PUSH_POST_DEFAULTS: Omit<PushPostOptions, 'timeoutMs'> = {
  lookup: publicOnlyLookup(),
  request: https.request,
};

/**
 * Posts the request; resolves to the push service's status code as soon as it
 * arrives, or rejects: a PushPostError (PUSH_HOST_NOT_PUBLIC, PUSH_TIMEOUT,
 * PUSH_BAD_STATUS, PUSH_NO_ANSWER), or the network's own error. The first
 * outcome settles it, and one always does.
 */
export function postPushRequest(details: PushRequestDetails, options: PushPostOptions): Promise<number> {
  const url = new URL(details.endpoint);
  if (net.isIP(url.hostname.replace(/^\[|\]$/g, '')) !== 0) return Promise.reject(new PushPostError('PUSH_HOST_NOT_PUBLIC'));
  const signal = AbortSignal.timeout(options.timeoutMs);
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      outcome();
    };
    const fail = (error: unknown) => settle(() => reject(signal.aborted ? new PushPostError('PUSH_TIMEOUT') : error));
    const request = options.request(
      {
        hostname: url.hostname,
        port: url.port ? Number(url.port) : 443,
        path: `${url.pathname}${url.search}`,
        method: details.method,
        headers: details.headers,
        lookup: options.lookup,
        agent: false,
        signal,
      },
      (response) => {
        const status = response.statusCode ?? 0;
        response.destroy();
        settle(() => (status < 100 || status > 599 ? reject(new PushPostError('PUSH_BAD_STATUS')) : resolve(status)));
      },
    );
    request.on('upgrade', (_response, socket) => {
      socket.destroy();
      settle(() => reject(new PushPostError('PUSH_BAD_STATUS')));
    });
    request.on('error', fail);
    request.on('close', () => fail(new PushPostError('PUSH_NO_ANSWER')));
    signal.addEventListener('abort', () => {
      request.destroy();
      settle(() => reject(new PushPostError('PUSH_TIMEOUT')));
    }, { once: true });
    request.end(details.body ?? undefined);
  });
}
