import assert from 'node:assert/strict'
import test from 'node:test'
import { verifyDockerWorkflow } from './verify-docker-workflow.mjs'

test('rejects a workflow without the main branch trigger', () => {
  const workflow = [
    'name: Docker',
    'on:',
    '  push:',
    '    tags: ["v*"]',
  ].join('\n')

  assert.throws(
    () => verifyDockerWorkflow(workflow),
    /main branch push trigger/,
  )
})

test('rejects a workflow that publishes before running the verification gate', () => {
  const workflow = [
    'name: Docker',
    'on:',
    '  push:',
    '    branches:',
    '      - main',
    '    tags: ["v*"]',
    '  workflow_dispatch:',
    'permissions:',
    '  contents: read',
    '  packages: write',
    'jobs:',
    '  docker:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/setup-node@v4',
    '        with:',
    '          node-version: "22"',
    '          cache: npm',
    '      - run: npm ci',
    '      - run: npm test',
    '      - run: npm run verify:docker-workflow',
    '      - run: npm run test:workflow',
    '      - run: npm run verify:docker-runtime',
    '      - run: npm run build',
    '      - uses: docker/build-push-action@v6',
    '        with:',
    '          push: true',
  ].join('\n')

  assert.throws(
    () => verifyDockerWorkflow(workflow),
    /verification gate must run before tests/,
  )
})

test('accepts equivalent YAML formatting for workflow values', async () => {
  const { readFile } = await import('node:fs/promises')
  const workflowPath = new URL('../.github/workflows/docker.yml', import.meta.url)
  const workflow = (await readFile(workflowPath, 'utf8'))
    .replace("tags: ['v*']", 'tags: ["v*"]')
    .replace('node-version: 22', 'node-version: "22"')

  assert.doesNotThrow(() => verifyDockerWorkflow(workflow))
})

test('smoke image script uses buildx with --load so the local image can be run', async () => {
  const { readFile } = await import('node:fs/promises')
  const smokePath = new URL('./smoke-docker-image.mjs', import.meta.url)
  const smoke = await readFile(smokePath, 'utf8')

  assert.match(smoke, /run\(\s*'docker',\s*\[\s*'buildx',\s*'build',\s*'--platform',\s*'linux\/amd64',\s*'--load',\s*'--progress=plain'/s)
})

test('smoke image script exercises the real nginx entrypoint and proxy checks', async () => {
  const { readFile } = await import('node:fs/promises')
  const smokePath = new URL('./smoke-docker-image.mjs', import.meta.url)
  const smoke = await readFile(smokePath, 'utf8')

  assert.ok(smoke.includes('/docker-entrypoint.sh nginx -g "daemon off;"'))
  assert.ok(smoke.includes('attempts=40'))
  assert.ok(smoke.includes("proxy_pass https://mock-api:8443/v1$uri$is_args$args;"))
  assert.ok(smoke.includes('wget -qO-'))
})

test('smoke image script sends real requests through a hostname-based mock upstream', async () => {
  const { readFile } = await import('node:fs/promises')
  const smokePath = new URL('./smoke-docker-image.mjs', import.meta.url)
  const smoke = await readFile(smokePath, 'utf8')

  assert.ok(smoke.includes("['network', 'create', networkName]"))
  assert.ok(smoke.includes('node:22-alpine'))
  assert.ok(smoke.includes("'--network-alias'"))
  assert.ok(smoke.includes('API_PROXY_URL=https://mock-api:8443/v1'))
  assert.ok(smoke.includes('openssl'))
  assert.ok(smoke.includes("['cp',"))
  assert.ok(smoke.includes('update-ca-certificates'))
  assert.ok(smoke.includes('wget -qO-'))
  assert.ok(smoke.includes('/api-proxy/responses?smoke=responses'))
  assert.ok(smoke.includes('/api-proxy/images/generations?smoke=images'))
  assert.ok(smoke.includes('/api-proxy/images/edits?smoke=edit'))
  assert.ok(smoke.includes('/api-proxy/responses?smoke=stream'))
  assert.ok(smoke.includes('/tmp/stream.out'))
  assert.ok(smoke.includes('multipart/form-data; boundary=----gptimageboundary'))
  assert.ok(smoke.includes('Authorization: Bearer smoke-token'))
  assert.ok(smoke.includes('RK API'))
  assert.ok(smoke.includes('__VITE_DEFAULT_API_URL_PLACEHOLDER__'))
  assert.ok(smoke.includes('SIGTERM'))
})
