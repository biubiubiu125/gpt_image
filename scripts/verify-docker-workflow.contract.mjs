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
