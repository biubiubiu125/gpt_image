import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const imageTag = `gpt_image-smoke:${process.pid}`

function run(command, args, label) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    stdio: 'inherit',
  })
  if (result.error) throw result.error
  assert.equal(
    result.status,
    0,
    `${label} failed with status ${result.status}`,
  )
  return result
}

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
      '-e',
      'ENABLE_API_PROXY=true',
      '-e',
      'DEFAULT_API_URL=https://api.veridiantech1.com',
      '-e',
      'API_PROXY_URL=https://api.veridiantech1.com/v1',
      imageTag,
      'sh',
      '-eu',
      '-c',
      "nginx -t && grep -R -F -q 'RK API' /usr/share/nginx/html/assets && grep -R -F -q 'https://api.veridiantech1.com' /usr/share/nginx/html/assets && ! grep -R -F -q '__VITE_DEFAULT_API_URL_PLACEHOLDER__' /usr/share/nginx/html/assets && grep -F -q 'rewrite ^/api-proxy/(.*)$ /$1 break;' /etc/nginx/conf.d/default.conf && grep -F -q 'proxy_pass https://api.veridiantech1.com/v1$uri$is_args$args;' /etc/nginx/conf.d/default.conf",
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
