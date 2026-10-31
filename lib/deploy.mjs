import { isAbsolute } from 'node:path';

export function deploymentSettings(env) {
  for (const name of ['DEPLOY_HOST', 'DEPLOY_USER', 'DEPLOY_SSH_KEY', 'DEPLOY_KNOWN_HOSTS']) {
    if (!env[name]?.trim()) throw new Error(`Missing ${name}`);
  }
  const host = env.DEPLOY_HOST.trim();
  const user = env.DEPLOY_USER.trim();
  const port = env.DEPLOY_PORT?.trim() || '22';
  const path = (env.DEPLOY_PATH?.trim() || '/srv/sing-box').replace(/\/+$/, '');
  const group = env.DEPLOY_GROUP?.trim() || 'caddy';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(host)) throw new Error('DEPLOY_HOST must be a hostname or IPv4 address');
  if (!/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(user)) throw new Error('Invalid DEPLOY_USER');
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error('Invalid DEPLOY_PORT');
  if (!isAbsolute(path) || path === '/' || !/^\/[a-zA-Z0-9_./-]+$/.test(path) || path.split('/').some(p => p === '..' || p === '.')) {
    throw new Error('DEPLOY_PATH must be an absolute directory without spaces or traversal components');
  }
  if (!/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(group)) throw new Error('Invalid DEPLOY_GROUP');
  return { host, user, port, path, group };
}

export const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";

export function sshOptions(key, knownHosts) {
  return ['-F', '/dev/null', '-i', key,
    '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes',
    '-o', `UserKnownHostsFile=${knownHosts}`, '-o', 'GlobalKnownHostsFile=/dev/null',
    '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3'];
}
