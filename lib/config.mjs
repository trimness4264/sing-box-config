import { isDeepStrictEqual } from 'node:util';

const own = (object, key) => Object.hasOwn(object, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const blocked = new Set(['__proto__', 'constructor', 'prototype']);

function locate(parent, segment, allowNew = false) {
  if (typeof segment === 'string') {
    if (!object(parent) || blocked.has(segment)) throw new Error('Invalid object path');
    if (!allowNew && !own(parent, segment)) throw new Error(`Missing field: ${segment}`);
    return segment;
  }
  if (!Array.isArray(parent) || !object(segment) || Object.keys(segment).length === 0) {
    throw new Error('Array paths require a nonempty selector object');
  }
  const matches = parent.flatMap((entry, index) =>
    object(entry) && Object.entries(segment).every(([key, value]) =>
      !blocked.has(key) && own(entry, key) && isDeepStrictEqual(entry[key], value)) ? [index] : []);
  if (matches.length !== 1) throw new Error(`Selector matched ${matches.length} entries; expected exactly one`);
  return matches[0];
}

export function applyOverlay(common, overlay) {
  if (!object(overlay) || !Array.isArray(overlay.operations) || Object.keys(overlay).some(k => k !== 'operations')) {
    throw new Error('Platform file must contain only an operations array');
  }
  const result = structuredClone(common);
  for (const [index, operation] of overlay.operations.entries()) {
    try {
      if (!object(operation) || !['set', 'remove', 'insert_after'].includes(operation.op)) {
        throw new Error('Unknown operation');
      }
      if (!Array.isArray(operation.path) || operation.path.length === 0) throw new Error('Missing path');
      if (operation.op !== 'remove' && !own(operation, 'value')) throw new Error('Missing value');
      if (Object.keys(operation).some(k => !['op', 'path', 'value'].includes(k))) throw new Error('Unknown operation field');
      let parent = result;
      for (const segment of operation.path.slice(0, -1)) parent = parent[locate(parent, segment)];
      const key = locate(parent, operation.path.at(-1), operation.op === 'set');
      if (operation.op === 'set') parent[key] = structuredClone(operation.value);
      else if (operation.op === 'remove') {
        if (Array.isArray(parent)) parent.splice(key, 1);
        else delete parent[key];
      } else {
        if (!Array.isArray(parent)) throw new Error('insert_after requires an array selector');
        parent.splice(key + 1, 0, structuredClone(operation.value));
      }
    } catch (error) {
      throw new Error(`Operation ${index + 1} (${JSON.stringify(operation.path)}): ${error.message}`);
    }
  }
  return result;
}

function list(value) {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

function tags(entries, label, multiple = false) {
  const result = new Set();
  for (const entry of entries ?? []) {
    const names = multiple ? list(entry.tag) : [entry.tag];
    if (!names.length) throw new Error(`Missing ${label} tag`);
    for (const tag of names) {
      if (typeof tag !== 'string' || !tag || result.has(tag)) throw new Error(`Invalid or duplicate ${label} tag`);
      result.add(tag);
    }
  }
  return result;
}

export function validateReferences(config) {
  const endpoints = config.endpoints ?? [];
  const outbounds = tags([...(config.outbounds ?? []), ...endpoints], 'outbound/endpoint');
  const inbounds = tags([...(config.inbounds ?? []), ...endpoints], 'inbound/endpoint');
  const dns = tags(config.dns?.servers, 'DNS server');
  const sets = tags(config.route?.rule_set, 'rule-set', true);
  const requireTag = (value, available, label) => {
    for (const tag of list(value)) if (!available.has(tag)) throw new Error(`Unknown ${label}: ${tag}`);
  };
  for (const outbound of config.outbounds ?? []) {
    requireTag(outbound.outbounds, outbounds, 'selector member');
    requireTag(outbound.default, outbounds, 'selector default');
    if (outbound.default && !list(outbound.outbounds).includes(outbound.default)) {
      throw new Error(`Selector default is not a member: ${outbound.tag}`);
    }
  }
  const walk = value => {
    if (Array.isArray(value)) return value.forEach(walk);
    if (!object(value)) return;
    if (own(value, 'detour')) requireTag(value.detour, outbounds, 'detour');
    Object.values(value).forEach(walk);
  };
  walk(config);
  const rules = (entries, dnsRule) => {
    for (const rule of entries ?? []) {
      requireTag(rule.rule_set, sets, 'rule-set');
      requireTag(rule.outbound, outbounds, 'outbound');
      requireTag(rule.inbound, inbounds, 'inbound');
      if (dnsRule || rule.action === 'resolve') requireTag(rule.server, dns, 'DNS server');
      rules(rule.rules, dnsRule);
    }
  };
  rules(config.route?.rules, false);
  rules(config.dns?.rules, true);
  requireTag(config.route?.final, outbounds, 'final outbound');
  requireTag(config.route?.default_domain_resolver, dns, 'default DNS resolver');
  requireTag(config.dns?.final, dns, 'final DNS server');
}
