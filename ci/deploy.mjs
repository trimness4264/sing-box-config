import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { deploymentSettings, shellQuote as q, sshOptions } from '../lib/deploy.mjs';
import { validateReferences } from '../lib/config.mjs';
import { platformFiles } from '../lib/platforms.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

async function main() {
  const settings = deploymentSettings(process.env);
  const files = await platformFiles(root);
  const checksums = [];
  for (const file of files) {
    const content = await readFile(join(root, 'dist', file));
    validateReferences(JSON.parse(content));
    checksums.push(`${createHash('sha256').update(content).digest('hex')}  ${file}`);
  }
  const scratch = await mkdtemp(join(tmpdir(), 'sing-box-deploy-'));
  try {
    const key = join(scratch, 'key');
    const knownHosts = join(scratch, 'known_hosts');
    const sums = join(scratch, 'SHA256SUMS');
    await writeFile(key, process.env.DEPLOY_SSH_KEY.trim() + '\n', { mode: 0o600 });
    await writeFile(knownHosts, process.env.DEPLOY_KNOWN_HOSTS.trim() + '\n', { mode: 0o600 });
    await writeFile(sums, checksums.join('\n') + '\n', { mode: 0o600 });
    const target = `${settings.user}@${settings.host}`;
    const options = sshOptions(key, knownHosts);
    const ssh = ['-p', settings.port, ...options, target];
    const release = `${Date.now()}-${randomUUID()}`;
    const remote = `${settings.path}/releases/${release}`;
    const run = (command, args, input) => {
      const result = spawnSync(command, args, { input, encoding: 'utf8', timeout: 120_000 });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr?.trim() || result.status}`);
      if (result.stdout?.trim()) console.log(result.stdout.trim());
    };
    // The deployment root must be provisioned once; CI never uses sudo.
    run('ssh', [...ssh, `test -d ${q(settings.path)} && test -w ${q(settings.path)} && mkdir -p ${q(settings.path + '/releases')} && chgrp ${q(settings.group)} ${q(settings.path + '/releases')} && chmod 2750 ${q(settings.path + '/releases')} && mkdir -m 2750 ${q(remote)}`]);
    run('scp', ['-q', '-P', settings.port, ...options,
      ...files.map(file => join(root, 'dist', file)), sums, `${target}:${remote}/`]);
    const publish = await readFile(join(root, 'ci/publish.sh'), 'utf8');
    run('ssh', [...ssh, `flock -w 60 ${q(settings.path + '/.publish.lock')} sh -s -- ${q(settings.path)} ${q(release)} ${q(settings.group)} ${files.map(q).join(' ')}`], publish);
    console.log(`Published ${files.length} configurations as release ${release}`);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
