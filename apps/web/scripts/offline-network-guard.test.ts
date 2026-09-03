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
