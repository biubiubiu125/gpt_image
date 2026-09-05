import { readFileSync } from 'node:fs'

const workflow = readFileSync('.github/workflows/docker.yml', 'utf8')
const required = [
  'branches:',
  '- main',
  'tags:',
  "'v*'",
  'workflow_dispatch:',
  'packages: write',
  'ghcr.io/biubiubiu125/gpt_image',
  'npm ci',
  'npm test',
  'npm run build',
  'docker/login-action@v3',
  'docker/build-push-action@v6',
  'linux/amd64,linux/arm64',
  'push: true',
  'type=raw,value=latest',
  'type=sha',
]

for (const value of required) {
  if (!workflow.includes(value)) throw new Error(`Missing workflow contract: ${value}`)
}

const orderedSteps = ['npm ci', 'npm test', 'npm run build', 'docker/login-action@v3', 'docker/build-push-action@v6']
let previousIndex = -1
for (const value of orderedSteps) {
  const index = workflow.indexOf(value)
  if (index <= previousIndex) throw new Error(`Invalid workflow step order: ${value}`)
  previousIndex = index
}

console.log('Docker workflow contract passed')
