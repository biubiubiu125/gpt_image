import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

function asRecord(value, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message)
  return value
}

function asList(value) {
  if (Array.isArray(value)) return value.map(String)
  if (typeof value === 'string') return [value]
  return []
}

function normalizeScalar(value) {
  return typeof value === 'string' ? value.trim() : String(value ?? '').trim()
}

function findStep(steps, predicate, message) {
  const index = steps.findIndex(predicate)
  if (index < 0) throw new Error(message)
  return index
}

function findRunStep(steps, command, message = `Missing workflow step: ${command}`) {
  return findStep(
    steps,
    (step) => step && typeof step === 'object' && !Array.isArray(step) && normalizeScalar(step.run) === command,
    message,
  )
}

function findUsesStep(steps, action, message = `Missing workflow action: ${action}`) {
  return findStep(
    steps,
    (step) => step && typeof step === 'object' && !Array.isArray(step) && normalizeScalar(step.uses) === action,
    message,
  )
}

function findStepById(steps, id, message) {
  return findStep(
    steps,
    (step) => step && typeof step === 'object' && !Array.isArray(step) && normalizeScalar(step.id) === id,
    message,
  )
}

function requireExact(actual, expected, message) {
  assert.equal(normalizeScalar(actual), expected, message)
}

function requireObjectProperty(record, key, message) {
  if (!Object.prototype.hasOwnProperty.call(record, key)) throw new Error(message)
  return record[key]
}

function requireMetadataTag(tags, expected, message) {
  if (!tags.some((tag) => normalizeScalar(tag) === expected)) throw new Error(message)
}

function assertOrdered(indices, message) {
  let previous = -1
  for (const index of indices) {
    if (index <= previous) throw new Error(message)
    previous = index
  }
}

export function verifyDockerWorkflow(workflow) {
  let config
  try {
    config = parse(workflow.replace(/\r\n?/g, '\n'))
  } catch (error) {
    throw new Error(`Invalid Docker workflow YAML: ${error instanceof Error ? error.message : String(error)}`)
  }

  const root = asRecord(config, 'Docker workflow root must be an object')
  const triggers = asRecord(requireObjectProperty(root, 'on', 'Missing workflow trigger block'), 'Workflow triggers must be an object')
  const push = asRecord(requireObjectProperty(triggers, 'push', 'Missing push trigger'), 'Push trigger must be an object')
  if (!asList(push.branches).includes('main')) throw new Error('Missing main branch push trigger')
  if (!asList(push.tags).some((tag) => normalizeScalar(tag) === 'v*')) throw new Error('Missing version tag push trigger')
  if (!Object.prototype.hasOwnProperty.call(triggers, 'workflow_dispatch')) {
    throw new Error('Missing manual workflow trigger')
  }

  const permissions = asRecord(requireObjectProperty(root, 'permissions', 'Missing workflow permissions'), 'Workflow permissions must be an object')
  requireExact(permissions.contents, 'read', 'Missing contents read permission')
  requireExact(permissions.packages, 'write', 'Missing packages write permission')

  const jobs = asRecord(requireObjectProperty(root, 'jobs', 'Missing jobs block'), 'Jobs block must be an object')
  const dockerJob = asRecord(requireObjectProperty(jobs, 'docker', 'Missing docker job'), 'Docker job must be an object')
  const steps = requireObjectProperty(dockerJob, 'steps', 'Missing docker job steps')
  if (!Array.isArray(steps)) throw new Error('Docker job steps must be an array')

  const setupNodeIndex = findUsesStep(steps, 'actions/setup-node@v4', 'Missing Node.js setup step')
  const setupNode = asRecord(steps[setupNodeIndex], 'Node.js setup step must be an object')
  const setupNodeWith = asRecord(setupNode.with, 'Node.js setup step must define with options')
  requireExact(setupNodeWith['node-version'], '22', 'Docker workflow must use Node.js 22')
  requireExact(setupNodeWith.cache, 'npm', 'Node.js setup must enable npm cache')

  const npmCiIndex = findRunStep(steps, 'npm ci', 'Missing npm ci step')
  const workflowGateIndex = findRunStep(steps, 'npm run verify:docker-workflow', 'Missing Docker workflow verification gate')
  const workflowContractIndex = findRunStep(steps, 'npm run test:workflow', 'Missing Docker workflow contract test step')
  const runtimeGateIndex = findRunStep(steps, 'npm run verify:docker-runtime', 'Missing Docker runtime verification gate')
  const npmTestIndex = findRunStep(steps, 'npm test', 'Missing npm test step')
  const npmBuildIndex = findRunStep(steps, 'npm run build', 'Missing npm build step')

  if (workflowGateIndex >= npmTestIndex || workflowContractIndex >= npmTestIndex || runtimeGateIndex >= npmTestIndex) {
    throw new Error('Docker verification gate must run before tests')
  }

  assertOrdered(
    [
      setupNodeIndex,
      npmCiIndex,
      workflowGateIndex,
      workflowContractIndex,
      runtimeGateIndex,
      npmTestIndex,
      npmBuildIndex,
    ],
    'Invalid Docker workflow step order',
  )

  const qemuIndex = findUsesStep(steps, 'docker/setup-qemu-action@v3', 'Missing QEMU setup step')
  const buildxIndex = findUsesStep(steps, 'docker/setup-buildx-action@v3', 'Missing Buildx setup step')
  const smokeIndex = findRunStep(steps, 'npm run smoke:docker-image', 'Missing Docker image smoke test step')
  const loginIndex = findUsesStep(steps, 'docker/login-action@v3', 'Missing GHCR login step')
  const metadataIndex = findStepById(steps, 'meta', 'Missing Docker metadata step')
  const metadata = asRecord(steps[metadataIndex], 'Docker metadata step must be an object')
  const metadataWith = asRecord(metadata.with, 'Docker metadata step must define with options')
  requireExact(
    metadataWith.images,
    'ghcr.io/biubiubiu125/gpt_image',
    'Docker image must point to ghcr.io/biubiubiu125/gpt_image',
  )
  const metadataTags = typeof metadataWith.tags === 'string'
    ? metadataWith.tags.split('\n').map((tag) => tag.trim()).filter(Boolean)
    : asList(metadataWith.tags)
  requireMetadataTag(metadataTags, 'type=semver,pattern={{version}}', 'Missing semantic version tag')
  requireMetadataTag(metadataTags, 'type=semver,pattern={{major}}.{{minor}}', 'Missing major.minor tag')
  requireMetadataTag(metadataTags, 'type=raw,value=latest', 'Missing latest tag')
  requireMetadataTag(metadataTags, 'type=sha', 'Missing SHA tag')

  const buildPushIndex = findUsesStep(steps, 'docker/build-push-action@v6', 'Missing Docker build and push step')
  const buildPush = asRecord(steps[buildPushIndex], 'Docker build and push step must be an object')
  const buildPushWith = asRecord(buildPush.with, 'Docker build and push step must define with options')
  requireExact(buildPushWith.context, '.', 'Missing Docker build context')
  requireExact(buildPushWith.file, 'deploy/Dockerfile', 'Missing deployment Dockerfile')
  const platforms = asList(buildPushWith.platforms)
    .flatMap((value) => value.split(',').map((platform) => platform.trim()))
  if (!platforms.includes('linux/amd64') || !platforms.includes('linux/arm64')) {
    throw new Error('Missing amd64/arm64 build platforms')
  }
  if (buildPushWith.push !== true) throw new Error('Docker build must push the image')
  requireExact(buildPushWith.tags, '${{ steps.meta.outputs.tags }}', 'Missing metadata tags output')
  requireExact(buildPushWith.labels, '${{ steps.meta.outputs.labels }}', 'Missing metadata labels output')

  assertOrdered(
    [npmBuildIndex, qemuIndex, buildxIndex, smokeIndex, loginIndex, metadataIndex, buildPushIndex],
    'Invalid Docker workflow step order',
  )

  for (const forbidden of [
    'ghcr.io/cooksleep/gpt_image_playground',
    'ghcr.io/${{ github.repository_owner }}/gpt_image_playground',
    'ghcr.io/biubiubiu125/gpt_image_playground',
  ]) {
    if (workflow.includes(forbidden)) throw new Error(`Workflow contains obsolete Docker image: ${forbidden}`)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const workflowPath = fileURLToPath(new URL('../.github/workflows/docker.yml', import.meta.url))
  verifyDockerWorkflow(readFileSync(workflowPath, 'utf8'))
  console.log('Docker workflow contract passed')
}
