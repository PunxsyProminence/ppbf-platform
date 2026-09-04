import { execFileSync } from 'node:child_process';
import path from 'node:path';

const guardPath = path.resolve(__dirname, 'offline-network-guard.cjs');

function evaluateGuard(expression: string) {
  const script = `
    const m = require(${JSON.stringify(guardPath)});
    const value = (${expression});
    process.stdout.write(JSON.stringify(value ?? null));
  `;
  return JSON.parse(execFileSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  }));
}

function requestOutcome(target: string) {
  const script = `
    const http = require('node:http');
    const https = require('node:https');
    const net = require('node:net');
    require(${JSON.stringify(guardPath)});
    const results = {};
    const check = (name, fn) => {
      try {
        fn();
        results[name] = 'allowed';
      } catch (error) {
        results[name] = error && error.code === 'PPBF_OFFLINE_NETWORK_BLOCKED' ? 'blocked' : String(error && error.message);
      }
    };
    check('http', () => http.request(${JSON.stringify(target)}));
    check('https', () => https.request(${JSON.stringify(target.replace('http://', 'https://'))}));
    check('socket', () => net.Socket.prototype.connect.call({ }, { host: ${JSON.stringify(new URL(target).hostname)}, port: 80 }));
    process.stdout.write(JSON.stringify(results));
  `;
  return JSON.parse(execFileSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  }));
}

function fetchOutcome(target: string) {
  const script = `
    (async () => {
      let callCount = 0;
      globalThis.fetch = async function fakeFetch() {
        callCount += 1;
        return { ok: true, marker: 'delegate-response' };
      };
      require(${JSON.stringify(guardPath)});
      const result = {};
      try {
        result.value = await globalThis.fetch(${JSON.stringify(target)});
        result.outcome = 'resolved';
      } catch (error) {
        result.outcome = 'rejected';
        result.code = error && error.code;
      }
      result.callCount = callCount;
      process.stdout.write(JSON.stringify(result));
    })();
  `;
  return JSON.parse(execFileSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  }));
}

describe('offline network guard loopback', () => {
  test('localhost, ::1, and literal 127.0.0.0/8 addresses are allowed', () => {
    expect(evaluateGuard("m.isLoopback('localhost')")).toBe(true);
    expect(evaluateGuard("m.isLoopback('::1')")).toBe(true);
    expect(evaluateGuard("m.isLoopback('127.0.0.1')")).toBe(true);
    expect(evaluateGuard("m.isLoopback('127.1.2.3')")).toBe(true);
  });

  test('127.example.com and other 127.* hostnames are rejected', () => {
    expect(evaluateGuard("m.isLoopback('127.example.com')")).toBe(false);
    expect(evaluateGuard("m.isLoopback('127.0.0')")).toBe(false);
    expect(evaluateGuard("m.isLoopback('127.0.0.1.2')")).toBe(false);
    expect(evaluateGuard("m.isLoopback('127.0.0.01')")).toBe(false);
    expect(evaluateGuard("m.isLoopback('127.0.0.256')")).toBe(false);
  });

  test('external hostnames and IPv4 addresses are rejected', () => {
    expect(evaluateGuard("m.isLoopback('example.com')")).toBe(false);
    expect(evaluateGuard("m.isLoopback('8.8.8.8')")).toBe(false);
  });

  test('HTTP, HTTPS, and raw sockets all refuse hostname-prefix spoofing', () => {
    expect(requestOutcome('http://127.example.com/')).toEqual({
      http: 'blocked',
      https: 'blocked',
      socket: 'blocked',
    });
    expect(requestOutcome('http://example.com/')).toEqual({
      http: 'blocked',
      https: 'blocked',
      socket: 'blocked',
    });
    expect(requestOutcome('http://8.8.8.8/')).toEqual({
      http: 'blocked',
      https: 'blocked',
      socket: 'blocked',
    });
  });
});

describe('offline network guard fetch', () => {
  // The fake fetch is installed BEFORE the guard is required, so the guard
  // captures the fake -- never a real network-capable implementation -- as
  // its delegate. No DNS lookup or real connection is reachable from either
  // case below, regardless of the target string's syntactic shape.
  test('a non-loopback fetch is rejected before the original fetch delegate is ever called', () => {
    const result = fetchOutcome('http://example.com/');
    expect(result.outcome).toBe('rejected');
    expect(result.code).toBe('PPBF_OFFLINE_NETWORK_BLOCKED');
    expect(result.callCount).toBe(0);
  });

  test('a loopback fetch delegates to the original fetch exactly once, with its result passed through', () => {
    const result = fetchOutcome('http://127.0.0.1:1/');
    expect(result.outcome).toBe('resolved');
    expect(result.value).toEqual({ ok: true, marker: 'delegate-response' });
    expect(result.callCount).toBe(1);
  });
});
