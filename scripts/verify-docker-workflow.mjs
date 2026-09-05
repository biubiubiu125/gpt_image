import { readFileSync } from 'node:fs'

const workflow = readFileSync('.github/workflows/docker.yml', 'utf8')
const required = [
  'branches:',
  '- main',
  'tags:',
  "'v*'",
  'ghcr.io/biubiubiu125/gpt_image',
  'npm ci',
  'npm test',
  'npm run build',
  'linux/amd64,linux/arm64',
]

for (const value of required) {
  if (!workflow.includes(value)) throw new Error(`Missing workflow contract: ${value}`)
}

console.log('Docker workflow contract passed')
