/*
 * Address validation for outbound fetches.
 *
 * The core API input is a user supplied product URL that the server then
 * fetches, and adapters follow links discovered along the way. Unguarded, a
 * request to http://169.254.169.254/ reads cloud instance credentials and hands
 * them to whoever asked for the report.
 *
 * This module answers one question: may we connect to this address. It is
 * separated from the fetch itself because it is pure, and because the bypasses
 * live here rather than in the transport.
 */

/* A CIDR block, stored as the first address and a prefix length. */
interface Block { label: string; base: bigint; bits: number; size: 4 | 16 }

function v4ToBigInt(addr: string): bigint | null {
  const parts = addr.split('.');
  if (parts.length !== 4) return null;
  let out = 0n;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out = (out << 8n) | BigInt(n);
  }
  return out;
}

function v6ToBigInt(addr: string): bigint | null {
  /* Strip a zone index (fe80::1%eth0), which is not part of the address. */
  const bare = addr.split('%')[0] ?? '';

  /*
   * IPv4 mapped and IPv4 compatible forms embed a dotted quad in the last 32
   * bits: ::ffff:169.254.169.254. Expand it to hex so one parser handles both,
   * and so the mapped form cannot slip past the IPv4 rules by wearing an IPv6
   * costume. This is the classic bypass.
   */
  const dotted = bare.match(/^(.*:)((?:\d{1,3}\.){3}\d{1,3})$/);
  let text = bare;
  if (dotted) {
    const v4 = v4ToBigInt(dotted[2] ?? '');
    if (v4 === null) return null;
    const hi = (v4 >> 16n) & 0xffffn;
    const lo = v4 & 0xffffn;
    text = `${dotted[1]}${hi.toString(16)}:${lo.toString(16)}`;
  }

  const halves = text.split('::');
  if (halves.length > 2) return null;

  const parseGroups = (s: string): bigint[] | null => {
    if (!s) return [];
    const groups: bigint[] = [];
    for (const g of s.split(':')) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
      groups.push(BigInt(parseInt(g, 16)));
    }
    return groups;
  };

  const head = parseGroups(halves[0] ?? '');
  const tail = halves.length === 2 ? parseGroups(halves[1] ?? '') : [];
  if (head === null || tail === null) return null;

  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 0 : missing !== 0) return null;

  const groups = [...head, ...Array<bigint>(halves.length === 2 ? missing : 0).fill(0n), ...tail];
  if (groups.length !== 8) return null;

  let out = 0n;
  for (const g of groups) out = (out << 16n) | g;
  return out;
}

function cidr(label: string, block: string, size: 4 | 16): Block {
  const [addr, prefix] = block.split('/');
  const base = size === 4 ? v4ToBigInt(addr ?? '') : v6ToBigInt(addr ?? '');
  if (base === null) throw new Error(`unparseable block in the guard list: ${block}`);
  return { label, base, bits: Number(prefix), size };
}

/*
 * Everything that is not a public internet host.
 *
 * Wider than the obvious private ranges on purpose. Carrier grade NAT, the
 * benchmarking range and the 6to4 relay block are all reachable from inside
 * real networks, and a guard that only knows about RFC1918 is a guard that
 * looks right in review and fails in production.
 */
const V4_BLOCKED: Block[] = [
  cidr('this network', '0.0.0.0/8', 4),
  cidr('private', '10.0.0.0/8', 4),
  cidr('carrier grade nat', '100.64.0.0/10', 4),
  cidr('loopback', '127.0.0.0/8', 4),
  cidr('link local, includes cloud metadata', '169.254.0.0/16', 4),
  cidr('private', '172.16.0.0/12', 4),
  cidr('ietf protocol assignments', '192.0.0.0/24', 4),
  cidr('test net 1', '192.0.2.0/24', 4),
  cidr('6to4 relay', '192.88.99.0/24', 4),
  cidr('private', '192.168.0.0/16', 4),
  cidr('benchmarking', '198.18.0.0/15', 4),
  cidr('test net 2', '198.51.100.0/24', 4),
  cidr('test net 3', '203.0.113.0/24', 4),
  cidr('multicast', '224.0.0.0/4', 4),
  cidr('reserved', '240.0.0.0/4', 4),
];

const V6_BLOCKED: Block[] = [
  cidr('unspecified', '::/128', 16),
  cidr('loopback', '::1/128', 16),
  cidr('unique local', 'fc00::/7', 16),
  cidr('link local', 'fe80::/10', 16),
  cidr('multicast', 'ff00::/8', 16),
  cidr('documentation', '2001:db8::/32', 16),
];

/*
 * IPv4 mapped and NAT64 prefixes. An address inside one of these carries an
 * IPv4 address in its low 32 bits, and that address is what actually gets
 * routed, so it must be checked against the IPv4 rules rather than the IPv6
 * ones. Missing this is how ::ffff:127.0.0.1 reaches localhost.
 */
const V6_EMBEDS_V4: Block[] = [
  cidr('ipv4 mapped', '::ffff:0:0/96', 16),
  cidr('nat64', '64:ff9b::/96', 16),
];

function inBlock(value: bigint, block: Block): boolean {
  const width = block.size === 4 ? 32 : 128;
  const shift = BigInt(width - block.bits);
  return (value >> shift) === (block.base >> shift);
}

export interface AddressVerdict {
  allowed: boolean;
  /* Present when blocked. Safe to show a caller: it names a range, not a host. */
  reason?: string;
}

/*
 * Judge one resolved address. Takes the literal, not a hostname: name
 * resolution belongs to the caller, which is what lets the same address be
 * checked and then connected to.
 */
export function checkAddress(address: string, family?: 4 | 6): AddressVerdict {
  const looksV6 = family === 6 || address.includes(':');

  if (!looksV6) {
    const v4 = v4ToBigInt(address);
    if (v4 === null) return { allowed: false, reason: 'unparseable address' };
    if (v4 === 0xffffffffn) return { allowed: false, reason: 'broadcast' };
    for (const b of V4_BLOCKED) {
      if (inBlock(v4, b)) return { allowed: false, reason: `${b.label} address is not routable to the public internet` };
    }
    return { allowed: true };
  }

  const v6 = v6ToBigInt(address);
  if (v6 === null) return { allowed: false, reason: 'unparseable address' };

  /* Unwrap an embedded IPv4 address and judge it as IPv4. */
  for (const embed of V6_EMBEDS_V4) {
    if (inBlock(v6, embed)) {
      const low = v6 & 0xffffffffn;
      const dotted = [24n, 16n, 8n, 0n].map((s) => Number((low >> s) & 0xffn)).join('.');
      return checkAddress(dotted, 4);
    }
  }

  for (const b of V6_BLOCKED) {
    if (inBlock(v6, b)) return { allowed: false, reason: `${b.label} address is not routable to the public internet` };
  }
  return { allowed: true };
}

/* Only these two schemes. file:, gopher:, ftp: and data: are all fetchable by
 * some clients and none of them are things this project reads. */
export function checkScheme(protocol: string): AddressVerdict {
  const p = protocol.toLowerCase();
  if (p === 'http:' || p === 'https:') return { allowed: true };
  return { allowed: false, reason: `scheme ${p} is not allowed, only http and https` };
}
