import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const runId = `${process.pid}-${Date.now()}`
const imageTag = `gpt_image-smoke:${runId}`
const networkName = `gpt_image_smoke_${runId}`
const upstreamName = `mock-api-${runId}`
const runtimeName = `gpt-image-runtime-${runId}`
const certificateDir = mkdtempSync(join(tmpdir(), 'gpt-image-smoke-'))
const certificatePath = join(certificateDir, 'mock-api.crt')
const certificateKeyPath = join(certificateDir, 'mock-api.key')

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function run(command, args, label, { attempts = 1, retryDelayMs = 3000, stdio = 'inherit' } = {}) {
  let lastResult

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = spawnSync(command, args, {
      cwd: projectRoot,
      stdio,
    })
    lastResult = result

    if (!result.error && result.status === 0) {
      return result
    }

    if (attempt < attempts) {
      console.warn(`${label} failed on attempt ${attempt}/${attempts}, retrying...`)
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

let cleanupStarted = false
let networkCreated = false
let imageBuilt = false
let upstreamStarted = false
let runtimeStarted = false

function cleanup() {
  if (cleanupStarted) return
  cleanupStarted = true

  const cleanupCommands = []
  if (runtimeStarted) cleanupCommands.push(['rm', '-f', runtimeName])
  if (upstreamStarted) cleanupCommands.push(['rm', '-f', upstreamName])
  if (imageBuilt) cleanupCommands.push(['image', 'rm', '-f', imageTag])
  if (networkCreated) cleanupCommands.push(['network', 'rm', networkName])

  for (const args of cleanupCommands) {
    const result = spawnSync('docker', args, {
      cwd: projectRoot,
      stdio: 'ignore',
    })
    if (result.error || result.status !== 0) {
      console.warn(`Cleanup command failed: docker ${args.join(' ')}`)
    }
  }

  rmSync(certificateDir, { recursive: true, force: true })
}

function exitForSignal(code) {
  cleanup()
  process.exit(code)
}

process.once('SIGINT', () => exitForSignal(130))
process.once('SIGTERM', () => exitForSignal(143))

function generateCertificate() {
  run(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-keyout',
      certificateKeyPath,
      '-out',
      certificatePath,
      '-subj',
      '/CN=mock-api',
      '-addext',
      'subjectAltName=DNS:mock-api',
    ],
    'Mock API TLS certificate generation',
    { stdio: 'ignore' },
  )
}

const upstreamScript = [
  'const fs = require("node:fs")',
  'const https = require("node:https")',
  'const certDir = "/tmp/certs"',
  'const certPath = `${certDir}/mock-api.crt`',
  'const keyPath = `${certDir}/mock-api.key`',
  'fs.mkdirSync(certDir, { recursive: true })',
  'const start = () => {',
  '  if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {',
  '    setTimeout(start, 100)',
  '    return',
  '  }',
  '  const server = https.createServer({ key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) }, (req, res) => {',
  '    let body = ""',
  '    req.setEncoding("utf8")',
  '    req.on("data", (chunk) => { body += chunk })',
  '    req.on("end", () => {',
  '      const payload = JSON.stringify({',
  '        path: req.url,',
  '        method: req.method,',
  '        auth: req.headers.authorization || "",',
  '        type: req.headers["content-type"] || "",',
  '        body,',
  '      })',
  '      if (req.method === "POST" && req.url.startsWith("/v1/responses?smoke=stream")) {',
  '        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" })',
  '        res.write(`data: ${JSON.stringify({ path: req.url, auth: req.headers.authorization || "", chunk: 1 })}\\n\\n`)',
  '        setTimeout(() => {',
  '          res.write(`data: ${JSON.stringify({ chunk: 2, body })}\\n\\n`)',
  '          res.end()',
  '        }, 2000)',
  '        return',
  '      }',
  '      if (req.method === "POST" && req.url.startsWith("/v1/responses")) {',
  '        res.writeHead(200, { "Content-Type": "application/json" })',
  '        res.end(payload)',
  '        return',
  '      }',
  '      if (req.method === "POST" && req.url.startsWith("/v1/images/generations")) {',
  '        res.writeHead(200, { "Content-Type": "application/json" })',
  '        res.end(payload)',
  '        return',
  '      }',
  '      if (req.method === "POST" && req.url.startsWith("/v1/images/edits")) {',
  '        res.writeHead(200, { "Content-Type": "application/json" })',
  '        res.end(payload)',
  '        return',
  '      }',
  '      res.writeHead(404, { "Content-Type": "application/json" })',
  '      res.end(JSON.stringify({ error: "not_found", path: req.url, method: req.method }))',
    '    })',
  '  })',
  '  server.listen(8443, "0.0.0.0")',
  '}',
  'start()',
].join('\n')

const runtimeSmokeScript = [
  'set -eu',
  'test -s /usr/local/share/ca-certificates/mock-api.crt',
  'update-ca-certificates',
  '/docker-entrypoint.sh nginx -g "daemon off;" >/tmp/nginx.log 2>&1 &',
  'pid=$!',
  'cleanup() {',
  '  kill "$pid" >/dev/null 2>&1 || true',
  '  wait "$pid" >/dev/null 2>&1 || true',
  '}',
  'trap cleanup EXIT',
  'attempts=40',
  'while :; do',
  '  if nginx -t >/tmp/nginx-test.log 2>&1 &&',
  '     grep -F -q "resolver " /etc/nginx/conf.d/default.conf &&',
  '     grep -F -q \'proxy_pass https://mock-api:8443/v1$uri$is_args$args;\' /etc/nginx/conf.d/default.conf &&',
  '     grep -F -q \'proxy_set_header Authorization $http_authorization;\' /etc/nginx/conf.d/default.conf; then',
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
  'echo STEP: asset injection',
  "grep -R -F -q 'RK API' /usr/share/nginx/html/assets",
  "grep -R -F -q 'https://api.veridiantech1.com/v1' /usr/share/nginx/html/assets",
  "if grep -R -F -q '__VITE_DEFAULT_API_URL_PLACEHOLDER__' /usr/share/nginx/html/assets; then echo 'default API placeholder still present' >&2; exit 1; fi",
  'proxy_request() {',
  '  request_url=$1',
  '  request_body=$2',
  '  attempts=20',
  '  while :; do',
  '    response=$(wget -qO- --header="Authorization: Bearer smoke-token" --header="Content-Type: application/json" --post-data="$request_body" "$request_url" 2>/dev/null) && { printf "%s" "$response"; return 0; }',
  '    attempts=$((attempts - 1))',
  '    if [ "$attempts" -le 0 ]; then',
  '      echo "Proxy smoke request timed out: $request_url" >&2',
  '      return 1',
  '    fi',
  '    sleep 1',
  '  done',
  '}',
  'echo STEP: real responses request',
  'response=$(proxy_request "http://127.0.0.1/api-proxy/responses?smoke=responses" \'{"input":"responses"}\')',
  'printf "%s\\n" "$response"',
  'printf "%s" "$response" | grep -F -q \'"path":"/v1/responses?smoke=responses"\'',
  'printf "%s" "$response" | grep -F -q \'"auth":"Bearer smoke-token"\'',
  'printf "%s" "$response" | grep -F -q \'"type":"application/json"\'',
  'printf "%s" "$response" | grep -F -q \'"body":"{\\"input\\":\\"responses\\"}"\'',
  'echo STEP: real images request',
  'imageResponse=$(proxy_request "http://127.0.0.1/api-proxy/images/generations?smoke=images" \'{"input":"images"}\')',
  'printf "%s\\n" "$imageResponse"',
  'printf "%s" "$imageResponse" | grep -F -q \'"path":"/v1/images/generations?smoke=images"\'',
  'printf "%s" "$imageResponse" | grep -F -q \'"auth":"Bearer smoke-token"\'',
  'printf "%s" "$imageResponse" | grep -F -q \'"body":"{\\"input\\":\\"images\\"}"\'',
  'echo STEP: multipart edit request',
  'cat <<\'EOF\' >/tmp/edit.multipart',
  '------gptimageboundary',
  'Content-Disposition: form-data; name="prompt"',
  '',
  'edit me',
  '------gptimageboundary',
  'Content-Disposition: form-data; name="image"; filename="edit.png"',
  'Content-Type: image/png',
  '',
  'sample image',
  '------gptimageboundary--',
  'EOF',
  'editResponse=$(wget -qO- --header="Authorization: Bearer smoke-token" --header="Content-Type: multipart/form-data; boundary=----gptimageboundary" --post-file=/tmp/edit.multipart "http://127.0.0.1/api-proxy/images/edits?smoke=edit")',
  'printf "%s\\n" "$editResponse"',
  'printf "%s" "$editResponse" | grep -F -q \'"path":"/v1/images/edits?smoke=edit"\'',
  'printf "%s" "$editResponse" | grep -F -q \'"auth":"Bearer smoke-token"\'',
  'printf "%s" "$editResponse" | grep -F -q \'"type":"multipart/form-data; boundary=----gptimageboundary"\'',
  'printf "%s" "$editResponse" | grep -F -q \'name=\\"prompt\\"\'',
  'printf "%s" "$editResponse" | grep -F -q \'name=\\"image\\"; filename=\\"edit.png\\"\'',
  'echo STEP: streaming responses request',
  'rm -f /tmp/stream.out',
  'wget -qO /tmp/stream.out -T 10 --header="Authorization: Bearer smoke-token" --header="Content-Type: application/json" --post-data=\'{"input":"stream"}\' "http://127.0.0.1/api-proxy/responses?smoke=stream" &',
  'stream_pid=$!',
  'attempts=10',
  'while [ "$attempts" -gt 0 ] && [ ! -s /tmp/stream.out ]; do sleep 0.1; attempts=$((attempts - 1)); done',
  'if [ ! -s /tmp/stream.out ]; then echo "Streaming response was buffered or never started" >&2; kill "$stream_pid" >/dev/null 2>&1 || true; wait "$stream_pid" >/dev/null 2>&1 || true; exit 1; fi',
  'wait "$stream_pid"',
  'grep -F -q \'"chunk":1\' /tmp/stream.out',
  'grep -F -q \'"chunk":2\' /tmp/stream.out',
  'grep -F -q \'"auth":"Bearer smoke-token"\' /tmp/stream.out',
  'grep -F -q \'"body":"{\\"input\\":\\"stream\\"}"\' /tmp/stream.out',
  'echo Docker runtime smoke passed',
].join('\n')

try {
  generateCertificate()
  run('docker', ['network', 'create', networkName], 'Docker network create')
  networkCreated = true
  run(
    'docker',
    ['buildx', 'build', '--platform', 'linux/amd64', '--load', '--progress=plain', '-f', 'deploy/Dockerfile', '-t', imageTag, '.'],
    'Docker image build',
  )
  imageBuilt = true
  run(
    'docker',
    [
      'run',
      '-d',
      '--name',
      upstreamName,
      '--network',
      networkName,
      '--network-alias',
      'mock-api',
      'node:22-alpine',
      'node',
      '-e',
      upstreamScript,
    ],
    'Mock API container start',
  )
  upstreamStarted = true
  run(
    'docker',
    ['exec', upstreamName, 'mkdir', '-p', '/tmp/certs'],
    'Mock API certificate directory',
    { attempts: 10, retryDelayMs: 100 },
  )
  run(
    'docker',
    ['cp', certificatePath, `${upstreamName}:/tmp/certs/mock-api.crt`],
    'Mock API certificate copy',
    { attempts: 10, retryDelayMs: 100 },
  )
  run(
    'docker',
    ['cp', certificateKeyPath, `${upstreamName}:/tmp/certs/mock-api.key`],
    'Mock API private key copy',
    { attempts: 10, retryDelayMs: 100 },
  )
  run(
    'docker',
    [
      'run',
      '--rm',
      '--name',
      runtimeName,
      '--network',
      networkName,
      '--mount',
      `type=bind,src=${certificatePath},dst=/usr/local/share/ca-certificates/mock-api.crt,readonly`,
      '--entrypoint',
      'sh',
      '-e',
      'ENABLE_API_PROXY=true',
      '-e',
      'DEFAULT_API_URL=https://api.veridiantech1.com/v1',
      '-e',
      'API_PROXY_URL=https://mock-api:8443/v1',
      imageTag,
      '-eu',
      '-c',
      runtimeSmokeScript,
    ],
    'Docker runtime smoke test',
  )
  runtimeStarted = true

  console.log('Docker image smoke passed')
} finally {
  cleanup()
}
