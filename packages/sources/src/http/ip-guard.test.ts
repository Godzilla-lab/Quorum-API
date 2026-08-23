import { test } from 'node:test';
import assert from 'node:assert/strict';

import { checkAddress, checkScheme } from './ip-guard.ts';

const blocked = (addr: string, family?: 4 | 6) => {
  const v = checkAddress(addr, family);
  assert.equal(v.allowed, false, `${addr} must be blocked`);
  assert.ok(v.reason, `${addr} must say why`);
};
const allowed = (addr: string, family?: 4 | 6) => {
  const v = checkAddress(addr, family);
  assert.equal(v.allowed, true, `${addr} must be allowed, got: ${v.reason ?? ''}`);
};

test('real public addresses are allowed', () => {
  for (const a of ['1.1.1.1', '8.8.8.8', '140.82.121.4', '93.184.216.34']) allowed(a);
  allowed('2606:4700:4700::1111');
  allowed('2001:4860:4860::8888');
});

/*
 * The one that matters most. Every major cloud serves instance credentials from
 * this address, so an unguarded fetch of a user supplied URL is a credential
 * disclosure, not a theoretical SSRF.
 */
test('the cloud metadata address is blocked', () => {
  blocked('169.254.169.254');
  blocked('169.254.170.2');
});

test('loopback and private ranges are blocked', () => {
  for (const a of [
    '127.0.0.1', '127.1.1.1',
    '10.0.0.1', '10.255.255.255',
    '172.16.0.1', '172.31.255.255',
    '192.168.0.1', '192.168.255.255',
    '0.0.0.0',
  ]) blocked(a);
});

test('ranges a naive RFC1918 guard would miss are blocked', () => {
  blocked('100.64.0.1');       // carrier grade nat
  blocked('198.18.0.1');       // benchmarking
  blocked('192.0.0.1');        // ietf protocol assignments
  blocked('192.88.99.1');      // 6to4 relay
  blocked('224.0.0.1');        // multicast
  blocked('240.0.0.1');        // reserved
  blocked('255.255.255.255');  // broadcast
});

test('addresses adjacent to a blocked range are still allowed', () => {
  allowed('172.15.255.255', 4);  // just below 172.16/12
  allowed('172.32.0.1', 4);      // just above
  allowed('169.253.255.255', 4); // just below link local
  allowed('11.0.0.1', 4);        // just above 10/8
  allowed('100.63.255.255', 4);  // just below cgnat
});

test('ipv6 loopback, link local and unique local are blocked', () => {
  blocked('::1');
  blocked('fe80::1');
  blocked('fc00::1');
  blocked('fd00::1');
  blocked('ff02::1');
  blocked('::');
});

/*
 * THE CLASSIC BYPASS. An IPv4 address wearing an IPv6 costume. A guard that
 * checks IPv6 rules against ::ffff:127.0.0.1 finds nothing wrong with it, and
 * the kernel then routes it straight to localhost.
 */
test('ipv4 mapped ipv6 addresses are unwrapped and judged as ipv4', () => {
  blocked('::ffff:127.0.0.1');
  blocked('::ffff:169.254.169.254');
  blocked('::ffff:10.0.0.1');
  blocked('::ffff:192.168.1.1');
  allowed('::ffff:1.1.1.1', 6);
});

test('nat64 embedded ipv4 is unwrapped too', () => {
  blocked('64:ff9b::127.0.0.1');
  blocked('64:ff9b::169.254.169.254');
});

test('a zone index does not smuggle a link local address through', () => {
  blocked('fe80::1%eth0');
});

test('unparseable input is refused rather than assumed safe', () => {
  for (const a of ['', 'not-an-address', '999.1.1.1', '1.2.3', '1.2.3.4.5', ':::1', 'gggg::1']) {
    blocked(a);
  }
});

test('only http and https are fetchable', () => {
  assert.equal(checkScheme('http:').allowed, true);
  assert.equal(checkScheme('https:').allowed, true);
  assert.equal(checkScheme('HTTPS:').allowed, true, 'scheme comparison is case insensitive');
  for (const s of ['file:', 'ftp:', 'gopher:', 'data:', 'blob:', 'ws:']) {
    assert.equal(checkScheme(s).allowed, false, `${s} must be refused`);
  }
});

test('a block reason names a range and never leaks the target', () => {
  const v = checkAddress('169.254.169.254');
  assert.doesNotMatch(v.reason ?? '', /169\.254/, 'error strings reach customers through API responses');
});
