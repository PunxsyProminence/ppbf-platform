/* Loaded only by `npm run offline`. Refuses every non-loopback connection. */
'use strict';

const net = require('node:net');
const http = require('node:http');
const https = require('node:https');

function isLiteralIpv4(host) {
  const parts = String(host).split('.');
  if (parts.length !== 4) return false;
  return parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) return false;
    const value = Number(part);
    return value >= 0 && value <= 255 && String(value) === part;
  });
}

function isLoopback(host) {
  if (!host) return true;
  const normalized = String(host).replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
  if (normalized === 'localhost' || normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') {
    return true;
  }
  if (!isLiteralIpv4(normalized)) return false;
  return Number(normalized.split('.')[0]) === 127;
}

function refused(host) {
  const error = new Error(`PPBF offline runtime blocked outbound network access to ${String(host || 'unknown host')}.`);
  error.code = 'PPBF_OFFLINE_NETWORK_BLOCKED';
  return error;
}

const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedConnect(...args) {
  const first = args[0];
  const host = typeof first === 'object' && first !== null ? (first.host ?? first.hostname) : (typeof first === 'number' ? args[1] : first);
  if (!isLoopback(host)) throw refused(host);
  return originalConnect.apply(this, args);
};

function guardRequest(original) {
  return function guardedRequest(...args) {
    const first = args[0];
    let host;

    if (typeof first === 'string') {
      try {
        host = new URL(first).hostname;
      } catch {
        host = undefined;
      }
    } else if (first instanceof URL) {
      host = first.hostname;
    } else {
      const options = first;
      host = options && typeof options === 'object'
        ? (options.hostname ?? options.host)
        : undefined;
      if (!host && args[1] && typeof args[1] === 'object') {
        host = args[1].hostname ?? args[1].host;
      }
    }

    if (!isLoopback(host)) throw refused(host);
    return original.apply(this, args);
  };
}

http.request = guardRequest(http.request);
http.get = guardRequest(http.get);
https.request = guardRequest(https.request);
https.get = guardRequest(https.get);

module.exports = { isLoopback, isLiteralIpv4 };
