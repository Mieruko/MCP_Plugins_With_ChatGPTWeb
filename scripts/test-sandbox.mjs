import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildDockerRunSpec, getSandboxStatus, resetSandboxStatusCache } from '../dist/lib/os-sandbox.js';

const names = [
  'WORKBENCH_SANDBOX_PROVIDER', 'WORKBENCH_SANDBOX_IMAGE', 'WORKBENCH_SANDBOX_USER',
  'WORKBENCH_SANDBOX_MEMORY_MB', 'WORKBENCH_SANDBOX_PIDS', 'WORKBENCH_SANDBOX_CPUS',
  'WORKBENCH_SANDBOX_DOCKER_BIN', 'ADMIN_TOKEN', 'MCP_AUTH_TOKEN', 'OPENAI_TUNNEL_API_KEY',
];
const saved = new Map(names.map(name => [name, process.env[name]]));
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'local-coder-sandbox-test-'));
const workspace = path.join(tmp, 'workspace');
const subdir = path.join(workspace, 'src');

function restoreEnv() {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  resetSandboxStatusCache();
}

try {
  await fs.mkdir(subdir, { recursive: true });

  process.env.WORKBENCH_SANDBOX_PROVIDER = 'none';
  resetSandboxStatusCache();
  const disabled = await getSandboxStatus(true);
  assert.equal(disabled.provider, 'none');
  assert.equal(disabled.configured, false);
  assert.equal(disabled.available, false);
  assert.equal(disabled.network, 'none');

  process.env.WORKBENCH_SANDBOX_PROVIDER = 'docker';
  process.env.WORKBENCH_SANDBOX_IMAGE = 'example/local-coder-sandbox:test';
  process.env.WORKBENCH_SANDBOX_USER = '12345:12345';
  process.env.WORKBENCH_SANDBOX_MEMORY_MB = '768';
  process.env.WORKBENCH_SANDBOX_PIDS = '96';
  process.env.WORKBENCH_SANDBOX_CPUS = '1.5';
  process.env.ADMIN_TOKEN = 'must-not-enter-container';
  process.env.MCP_AUTH_TOKEN = 'must-not-enter-container';
  process.env.OPENAI_TUNNEL_API_KEY = 'must-not-enter-container';

  const spec = buildDockerRunSpec(workspace, subdir, 'sh', ['-lc', 'echo ok'], { TEST_FLAG: 'yes' }, 'clc-sandbox-test');
  assert.equal(spec.bin, process.env.WORKBENCH_SANDBOX_DOCKER_BIN || 'docker');
  assert.equal(spec.containerName, 'clc-sandbox-test');
  assert.equal(spec.containerCwd, '/workspace/src');

  const valueAfter = flag => {
    const index = spec.args.indexOf(flag);
    assert.notEqual(index, -1, `missing ${flag}`);
    return spec.args[index + 1];
  };
  assert.equal(valueAfter('--network'), 'none');
  assert.equal(valueAfter('--cap-drop'), 'ALL');
  assert.equal(valueAfter('--security-opt'), 'no-new-privileges');
  assert.equal(valueAfter('--pids-limit'), '96');
  assert.equal(valueAfter('--memory'), '768m');
  assert.equal(valueAfter('--cpus'), '1.5');
  assert.equal(valueAfter('--user'), '12345:12345');
  assert.equal(valueAfter('--workdir'), '/workspace/src');
  assert.ok(spec.args.includes('--read-only'));

  const volumes = spec.args.flatMap((value, index) => value === '--volume' ? [spec.args[index + 1]] : []);
  assert.deepEqual(volumes, [`${path.resolve(workspace)}:/workspace:rw`]);
  const extra = path.join(tmp, 'git-common');
  await fs.mkdir(extra, { recursive: true });
  const mountedSpec = buildDockerRunSpec(
    workspace,
    subdir,
    'git',
    ['status'],
    { GIT_DIR: '/git-common/worktrees/demo' },
    'clc-sandbox-mount-test',
    [{ hostPath: extra, containerPath: '/git-common' }],
  );
  const mountedVolumes = mountedSpec.args.flatMap((value, index) => value === '--volume' ? [mountedSpec.args[index + 1]] : []);
  assert.deepEqual(mountedVolumes, [
    `${path.resolve(workspace)}:/workspace:rw`,
    `${path.resolve(extra)}:/git-common:rw`,
  ]);
  assert.ok(spec.args.includes('TEST_FLAG=yes'));
  assert.ok(spec.args.includes('HOME=/home/sandbox'));
  assert.ok(spec.args.includes('example/local-coder-sandbox:test'));
  assert.ok(!spec.args.some(value => value.includes('must-not-enter-container')));
  assert.ok(!spec.args.some(value => /^ADMIN_TOKEN=|^MCP_AUTH_TOKEN=|^OPENAI_TUNNEL_API_KEY=/.test(value)));

  assert.throws(
    () => buildDockerRunSpec(workspace, tmp, 'sh', ['-lc', 'pwd']),
    /SANDBOX_PATH_ESCAPE/,
  );

  process.env.WORKBENCH_SANDBOX_USER = '0:0';
  assert.throws(
    () => buildDockerRunSpec(workspace, workspace, 'sh', ['-lc', 'id']),
    /SANDBOX_CONFIG_INVALID/,
  );

  process.env.WORKBENCH_SANDBOX_USER = '12345:12345';
  process.env.WORKBENCH_SANDBOX_DOCKER_BIN = `definitely-missing-docker-${Date.now()}`;
  resetSandboxStatusCache();
  const missingDocker = await getSandboxStatus(true);
  assert.equal(missingDocker.provider, 'docker');
  assert.equal(missingDocker.configured, true);
  assert.equal(missingDocker.available, false);

  console.log('OK sandbox provider is opt-in and Docker run spec is workspace-bound, networkless, non-root and resource-limited');
} finally {
  restoreEnv();
  await fs.rm(tmp, { recursive: true, force: true });
}
