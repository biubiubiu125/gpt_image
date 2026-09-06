import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const imageTag = `gpt_image-smoke:${process.pid}`

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function run(command, args, label, { attempts = 1, retryDelayMs = 3000 } = {}) {
  let lastResult

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = spawnSync(command, args, {
      cwd: projectRoot,
      stdio: 'inherit',
    })
    lastResult = result

    if (!result.error && result.status === 0) {
      return result
    }

    if (attempt < attempts) {
      console.warn(
        `${label} failed on attempt ${attempt}/${attempts}, retrying...`,
      )
      sleep(retryDelayMs * attempt)
    }
  }

  if (lastResult?.error) throw lastResult.error
  assert.equal(
    lastResult?.status,
    0,
    `${label} failed with status ${lastResult?.status}`,
  )
  return lastResult
}

const runtimeSmokeScript = [
  'set -eu',
  '/docker-entrypoint.sh nginx -g "daemon off;" >/tmp/nginx.log 2>&1 &',
  'pid=$!',
  'cleanup() {',
  '  kill "$pid" >/dev/null 2>&1 || true',
  '  wait "$pid" >/dev/null 2>&1 || true',
  '}',
  'trap cleanup EXIT',
  'attempts=30',
  'while :; do',
  '  if nginx -t >/tmp/nginx-test.log 2>&1 &&',
  "     grep -R -F -q 'RK API' /usr/share/nginx/html/assets &&",
  "     grep -R -F -q 'https://api.veridiantech1.com/v1' /usr/share/nginx/html/assets &&",
  "     ! grep -R -F -q '__VITE_DEFAULT_API_URL_PLACEHOLDER__' /usr/share/nginx/html/assets &&",
  "     grep -F -q 'rewrite ^/api-proxy/(.*)$ /$1 break;' /etc/nginx/conf.d/default.conf &&",
  "     grep -F -q 'proxy_pass https://api.veridiantech1.com/v1$uri$is_args$args;' /etc/nginx/conf.d/default.conf; then",
  '    break',
  '  fi',
  '  attempts=$((attempts - 1))',
  '  if [ "$attempts" -le 0 ]; then',
  '    echo "Docker runtime smoke timed out" >&2',
  '    echo "--- /tmp/nginx.log ---" >&2',
  '    cat /tmp/nginx.log >&2 || true',
  '    echo "--- /tmp/nginx-test.log ---" >&2',
  '    cat /tmp/nginx-test.log >&2 || true',
  '    exit 1',
  '  fi',
  '  sleep 1',
  'done',
  'echo STEP: nginx config',
  'nginx -t',
  'echo STEP: asset branding',
  "grep -R -F -q 'RK API' /usr/share/nginx/html/assets",
  'echo STEP: asset default url',
  "grep -R -F -q 'https://api.veridiantech1.com/v1' /usr/share/nginx/html/assets",
  'echo STEP: placeholder removed',
  "if grep -R -F -q '__VITE_DEFAULT_API_URL_PLACEHOLDER__' /usr/share/nginx/html/assets; then echo 'placeholder still present' >&2; exit 1; fi",
  'echo STEP: nginx rewrite',
  "grep -F -q 'rewrite ^/api-proxy/(.*)$ /$1 break;' /etc/nginx/conf.d/default.conf",
  'echo STEP: nginx proxy pass',
  "grep -F -q 'proxy_pass https://api.veridiantech1.com/v1$uri$is_args$args;' /etc/nginx/conf.d/default.conf",
  'echo Docker runtime smoke passed',
].join('\n')

try {
  run(
    'docker',
    ['buildx', 'build', '--platform', 'linux/amd64', '--load', '--progress=plain', '-f', 'deploy/Dockerfile', '-t', imageTag, '.'],
    'Docker image build',
  )
  run(
    'docker',
    [
      'run',
      '--rm',
      '--entrypoint',
      'sh',
      '-e',
      'ENABLE_API_PROXY=true',
      '-e',
      'DEFAULT_API_URL=https://api.veridiantech1.com/v1',
      '-e',
      'API_PROXY_URL=https://api.veridiantech1.com/v1',
      imageTag,
      '-eu',
      '-c',
      runtimeSmokeScript,
    ],
    'Docker runtime smoke test',
  )

  console.log('Docker image smoke passed')
} finally {
  spawnSync('docker', ['image', 'rm', '-f', imageTag], {
    cwd: projectRoot,
    encoding: 'utf8',
  })
}
