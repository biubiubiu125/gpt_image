import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const tempRoot = mkdtempSync(join(tmpdir(), 'gpt-image-docker-runtime-'))
const runtimeEnvironmentKeys = [
  'API_URL',
  'DEFAULT_API_URL',
  'API_PROXY_URL',
  'ENABLE_API_PROXY',
  'LOCK_API_PROXY',
  'SHOW_PRESET_CONFIG_ONLY',
  'SHOW_DEFAULT_CONFIG_ONLY',
  'LOCK_PRESET_CONFIG_PARAMS',
  'PREVENT_API_CONFIG_DELETION',
  'PREVENT_PRESET_CONFIG_DELETION',
  'DOCKER_LEGACY_API_URL_USED',
  'NGINX_RESOLVER',
]

function normalizeShellScript(source) {
  return source.replace(/\r\n?/g, '\n')
}

function writeExecutable(path, source) {
  writeFileSync(path, normalizeShellScript(source), { encoding: 'utf8', mode: 0o755 })
}

function toWslPath(path) {
  const normalized = path.replaceAll('\\', '/')
  const drivePath = normalized.match(/^([A-Za-z]):\/(.*)$/)
  return drivePath ? `/mnt/${drivePath[1].toLowerCase()}/${drivePath[2]}` : normalized
}

function cleanEnvironment(overrides = {}) {
  const env = { ...process.env }
  for (const key of [
    'API_URL',
    'DEFAULT_API_URL',
    'API_PROXY_URL',
    'ENABLE_API_PROXY',
    'LOCK_API_PROXY',
    'SHOW_PRESET_CONFIG_ONLY',
    'SHOW_DEFAULT_CONFIG_ONLY',
    'LOCK_PRESET_CONFIG_PARAMS',
    'PREVENT_API_CONFIG_DELETION',
    'PREVENT_PRESET_CONFIG_DELETION',
    'DOCKER_LEGACY_API_URL_USED',
    'NGINX_RESOLVER',
  ]) {
    delete env[key]
  }
  Object.assign(env, overrides)
  return env
}

function run(command, args, env) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    env,
    encoding: 'utf8',
  })
  if (result.error) throw result.error
  return result
}

function runShell(args, env) {
  if (process.platform !== 'win32') return run('sh', args, env)

  const environmentArgs = runtimeEnvironmentKeys
    .filter((key) => Object.prototype.hasOwnProperty.call(env, key))
    .map((key) => `${key}=${env[key]}`)
  const shellArgs = ['--exec', 'env', ...environmentArgs, 'sh', ...args.map((value) => (
    typeof value === 'string' && /^[A-Za-z]:[\\/]/.test(value) ? toWslPath(value) : value
  ))]
  return run('wsl.exe', shellArgs, env)
}

function assertCommandSucceeded(result, label) {
  assert.equal(
    result.status,
    0,
    `${label} failed with status ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  )
}

function verifyDockerfileEntrypointContract(dockerfile) {
  const normalized = normalizeShellScript(dockerfile)
  assert.match(normalized, /^FROM --platform=\$BUILDPLATFORM node:22-alpine AS build$/m)
  assert.match(normalized, /^RUN npm ci$/m)
  assert.match(normalized, /^RUN npm run build$/m)
  assert.match(normalized, /^FROM nginx:alpine$/m)
  assert.match(normalized, /^RUN apk add --no-cache ca-certificates$/m)
  assert.match(normalized, /^COPY --from=build \/app\/dist \/usr\/share\/nginx\/html$/m)
  assert.match(normalized, /^COPY deploy\/nginx\.conf \/etc\/nginx\/templates\/default\.conf\.template$/m)
  assert.match(normalized, /^COPY --chmod=755 deploy\/runtime-env\.sh \/usr\/local\/bin\/gpt-image-runtime-env\.sh$/m)
  assert.match(normalized, /^CMD \["nginx", "-g", "daemon off;"\]$/m)
  assert.doesNotMatch(normalized, /^ENV (DEFAULT_API_URL|API_PROXY_URL)=/m)

  const migrationCopy = normalized.indexOf(
    'COPY --chmod=755 deploy/migrate-api-env.envsh /docker-entrypoint.d/05-migrate-api-env.envsh',
  )
  const injectionCopy = normalized.indexOf(
    'COPY --chmod=755 deploy/inject-api-url.sh /docker-entrypoint.d/40-inject-api-url.sh',
  )
  assert.ok(migrationCopy >= 0, 'Dockerfile must copy the environment migration script into the entrypoint directory')
  assert.ok(injectionCopy >= 0, 'Dockerfile must copy the runtime injection script into the entrypoint directory')
  assert.ok(migrationCopy < injectionCopy, 'Environment migration must run before runtime asset injection')
}

function prepareMigrationFixture(scriptPath) {
  const shellRuntimeEnvPath = process.platform === 'win32'
    ? toWslPath(join(projectRoot, 'deploy', 'runtime-env.sh'))
    : join(projectRoot, 'deploy', 'runtime-env.sh')
  const fixtureScript = normalizeShellScript(readFileSync(scriptPath, 'utf8'))
    .replaceAll('/usr/local/bin/gpt-image-runtime-env.sh', shellRuntimeEnvPath)
  const patchedScriptPath = join(tempRoot, `migration-${Math.random().toString(36).slice(2)}.sh`)
  writeExecutable(patchedScriptPath, fixtureScript)
  return patchedScriptPath
}

function runMigration(scriptPath, overrides) {
  const patchedScriptPath = prepareMigrationFixture(scriptPath)
  const result = runShell(
    [
      '-c',
      'set -eu; . "$1"; printf "%s\n" "$DEFAULT_API_URL" "$API_PROXY_URL" "$DOCKER_LEGACY_API_URL_USED" "${NGINX_RESOLVER:-}"',
      'gpt-image-runtime-migration',
      patchedScriptPath,
    ],
    cleanEnvironment(overrides),
  )
  assertCommandSucceeded(result, 'Docker environment migration')
  const lines = result.stdout.replace(/\n$/, '').split('\n')
  assert.equal(lines.length, 4, `Unexpected migration output: ${result.stdout}`)
  return {
    defaultApiUrl: lines[0],
    apiProxyUrl: lines[1],
    legacyApiUrlUsed: lines[2],
    nginxResolver: lines[3],
  }
}

function runMigrationFailure(scriptPath, overrides) {
  const patchedScriptPath = prepareMigrationFixture(scriptPath)
  const result = runShell(
    [
      '-c',
      '. "$1"',
      'gpt-image-runtime-migration',
      patchedScriptPath,
    ],
    cleanEnvironment(overrides),
  )
  assert.notEqual(
    result.status,
    0,
    `Invalid Docker environment should fail, stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  )
}

function assertMigration(scriptPath, overrides, expected, message) {
  const actual = runMigration(scriptPath, overrides)
  assert.deepEqual(
    {
      defaultApiUrl: actual.defaultApiUrl,
      apiProxyUrl: actual.apiProxyUrl,
      legacyApiUrlUsed: actual.legacyApiUrlUsed,
    },
    expected,
    message,
  )
  return actual
}

function resetRuntimeFixture(htmlDir, nginxConfigPath) {
  mkdirSync(join(htmlDir, 'assets'), { recursive: true })
  writeFileSync(
    join(htmlDir, 'assets', 'app.js'),
    [
      'const defaultApiUrl = "__VITE_DEFAULT_API_URL_PLACEHOLDER__";',
      'const proxyAvailable = "__VITE_API_PROXY_AVAILABLE_PLACEHOLDER__";',
      'const proxyLocked = "__VITE_API_PROXY_LOCKED_PLACEHOLDER__";',
      'const dockerDeployment = "__VITE_DOCKER_DEPLOYMENT_PLACEHOLDER__";',
      'const legacyApiUrlUsed = "__VITE_DOCKER_LEGACY_API_URL_USED_PLACEHOLDER__";',
      'const presetOnly = "__VITE_SHOW_PRESET_CONFIG_ONLY_PLACEHOLDER__";',
      'const presetLocked = "__VITE_LOCK_PRESET_CONFIG_PARAMS_PLACEHOLDER__";',
      'const deletionPrevented = "__VITE_PREVENT_PRESET_CONFIG_DELETION_PLACEHOLDER__";',
    ].join('\n'),
  )
  writeFileSync(
    nginxConfigPath,
    [
      'server {',
      '    # BEGIN API PROXY',
      '    location /api-proxy/ {',
      '        proxy_pass https://proxy.example.com/v1/;',
      '    }',
      '    # END API PROXY',
      '    location / {',
      '        try_files $uri /index.html;',
      '    }',
      '}',
    ].join('\n'),
  )
}

function runInjector(scriptPath, htmlDir, nginxConfigPath, overrides, commandArgs = []) {
  const shellHtmlDir = process.platform === 'win32' ? toWslPath(htmlDir) : htmlDir
  const shellNginxConfigPath = process.platform === 'win32' ? toWslPath(nginxConfigPath) : nginxConfigPath
  const shellRuntimeEnvPath = process.platform === 'win32'
    ? toWslPath(join(projectRoot, 'deploy', 'runtime-env.sh'))
    : join(projectRoot, 'deploy', 'runtime-env.sh')
  const fixtureScript = normalizeShellScript(readFileSync(scriptPath, 'utf8'))
    .replaceAll('/usr/share/nginx/html', shellHtmlDir)
    .replaceAll('/etc/nginx/conf.d/default.conf', shellNginxConfigPath)
    .replaceAll('/usr/local/bin/gpt-image-runtime-env.sh', shellRuntimeEnvPath)
  const patchedScriptPath = join(tempRoot, `inject-api-url-${Math.random().toString(36).slice(2)}.sh`)
  writeExecutable(patchedScriptPath, fixtureScript)

  const result = runShell(['-eu', patchedScriptPath, ...commandArgs], cleanEnvironment(overrides))
  assertCommandSucceeded(result, 'Docker runtime injection')
  return readFileSync(join(htmlDir, 'assets', 'app.js'), 'utf8')
}

try {
  const migrationPath = join(projectRoot, 'deploy', 'migrate-api-env.envsh')
  const injectorPath = join(projectRoot, 'deploy', 'inject-api-url.sh')
  const dockerfile = readFileSync(join(projectRoot, 'deploy', 'Dockerfile'), 'utf8')
  const nginxTemplate = readFileSync(join(projectRoot, 'deploy', 'nginx.conf'), 'utf8')
  const injector = normalizeShellScript(readFileSync(injectorPath, 'utf8'))

  verifyDockerfileEntrypointContract(dockerfile)
  assert.match(injector, /^set -eu$/m, 'Runtime asset injection must fail fast on unset variables or command errors')

  const defaultMigration = assertMigration(
    migrationPath,
    {},
    {
      defaultApiUrl: 'https://api.veridiantech1.com/v1',
      apiProxyUrl: 'https://api.veridiantech1.com/v1',
      legacyApiUrlUsed: 'false',
    },
    'Unset Docker variables should use the raw RK API default and the /v1 proxy target',
  )
  assert.match(defaultMigration.nginxResolver, /\S+/, 'Docker runtime must discover at least one DNS resolver')
  assertMigration(
    migrationPath,
    { API_URL: 'https://legacy.example.com/v1/' },
    {
      defaultApiUrl: 'https://legacy.example.com/v1/',
      apiProxyUrl: 'https://legacy.example.com/v1',
      legacyApiUrlUsed: 'true',
    },
    'The legacy API_URL must migrate when the new variables are absent',
  )
  assertMigration(
    migrationPath,
    { API_URL: 'https://legacy.example.com' },
    {
      defaultApiUrl: 'https://legacy.example.com',
      apiProxyUrl: 'https://legacy.example.com/v1',
      legacyApiUrlUsed: 'true',
    },
    'A host-only legacy API_URL must preserve the old /v1 request behavior for the Nginx proxy',
  )
  assertMigration(
    migrationPath,
    { API_URL: 'https://legacy.example.com/custom' },
    {
      defaultApiUrl: 'https://legacy.example.com/custom',
      apiProxyUrl: 'https://legacy.example.com/custom/v1',
      legacyApiUrlUsed: 'true',
    },
    'A legacy API_URL with a non-version path must preserve the old path plus /v1 behavior for the Nginx proxy',
  )
  assertMigration(
    migrationPath,
    { API_URL: 'https://legacy.example.com/custom/' },
    {
      defaultApiUrl: 'https://legacy.example.com/custom/',
      apiProxyUrl: 'https://legacy.example.com/custom',
      legacyApiUrlUsed: 'true',
    },
    'A trailing slash in a legacy API_URL must preserve direct-path semantics for the Nginx proxy',
  )
  assertMigration(
    migrationPath,
    {
      API_URL: 'https://legacy.example.com/v1/',
      DEFAULT_API_URL: '',
    },
    {
      defaultApiUrl: '',
      apiProxyUrl: 'https://legacy.example.com/v1',
      legacyApiUrlUsed: 'true',
    },
    'An explicitly empty DEFAULT_API_URL must remain empty',
  )
  assertMigration(
    migrationPath,
    {
      API_URL: 'https://legacy.example.com/v1/',
      DEFAULT_API_URL: 'https://api.veridiantech1.com/v1',
    },
    {
      defaultApiUrl: 'https://api.veridiantech1.com/v1',
      apiProxyUrl: 'https://legacy.example.com/v1',
      legacyApiUrlUsed: 'true',
    },
    'An explicit new default must win over the legacy variable',
  )
  assert.equal(
    runMigration(migrationPath, {
      API_PROXY_URL: 'https://proxy.example.com/v1///',
    }).apiProxyUrl,
    'https://proxy.example.com/v1',
    'The proxy target must have one canonical trailing slash boundary',
  )
  assert.equal(
    runMigration(migrationPath, {
      API_PROXY_URL: 'https://proxy.example.com/v1',
      NGINX_RESOLVER: '1.1.1.1 8.8.8.8',
    }).nginxResolver,
    '1.1.1.1 8.8.8.8',
    'An explicit resolver override must be preserved',
  )
  assert.equal(
    runMigration(migrationPath, {
      API_PROXY_URL: 'https://proxy.example.com/v1',
      NGINX_RESOLVER: '[::1]',
    }).nginxResolver,
    '[::1]',
    'A bracketed IPv6 resolver must be accepted',
  )
  assert.equal(
    runMigration(migrationPath, {
      API_PROXY_URL: 'https://proxy.example.com/v1',
      NGINX_RESOLVER: '2001:4860:4860::8888',
    }).nginxResolver,
    '[2001:4860:4860::8888]',
    'An unbracketed IPv6 resolver must be normalized for Nginx syntax',
  )
  assert.equal(
    runMigration(migrationPath, {
      API_PROXY_URL: 'https://proxy.example.com:8443/v1',
    }).apiProxyUrl,
    'https://proxy.example.com:8443/v1',
    'A numeric non-standard HTTPS port must be preserved',
  )
  assert.equal(
    runMigration(migrationPath, {
      API_PROXY_URL: 'https://[::1]:8443/v1',
    }).apiProxyUrl,
    'https://[::1]:8443/v1',
    'A bracketed IPv6 proxy target with a numeric port must be accepted',
  )
  for (const invalidProxyUrl of [
    'https://proxy.example.com/v1?fixed=1',
    'https://proxy.example.com/v1#fragment',
    ' https://proxy.example.com/v1 ',
    'https://:443/v1',
    'https://proxy.example.com:bad/v1',
    'https://proxy.example.com:0/v1',
    'https://proxy.example.com:65536/v1',
    'https://[::1/v1',
    'https://[1.1.1.1]/v1',
    'https://2001:db8::1/v1',
  ]) {
    runMigrationFailure(migrationPath, { API_PROXY_URL: invalidProxyUrl })
  }
  for (const invalidResolver of [
    'resolver.example.com',
    '1.1.1.1;return 200',
    '999.1.1.1',
    '1.2.3.4.5',
    '[gg::1]',
    '[::1',
    '[1.1.1.1]',
  ]) {
    runMigrationFailure(migrationPath, {
      API_PROXY_URL: 'https://proxy.example.com/v1',
      NGINX_RESOLVER: invalidResolver,
    })
  }

  const htmlDir = join(tempRoot, 'html')
  const nginxConfigPath = join(tempRoot, 'default.conf')
  const localConfigPath = join(tempRoot, 'gpt-image-config.json')
  const localConfig = '{"profiles":[{"name":"Local RK API","provider":"openai"}]}'
  const embeddedLocalConfig = `embedded-config:${Buffer.from(localConfig).toString('base64')}`
  writeFileSync(localConfigPath, localConfig)
  resetRuntimeFixture(htmlDir, nginxConfigPath)
  const defaultAsset = runInjector(injectorPath, htmlDir, nginxConfigPath, {})
  assert.match(defaultAsset, /defaultApiUrl = "https:\/\/api\.veridiantech1\.com\/v1"/)
  assert.doesNotMatch(defaultAsset, /defaultApiUrl = "https:\/\/api\.veridiantech1\.com"/)

  resetRuntimeFixture(htmlDir, nginxConfigPath)
  const localPathAsset = runInjector(injectorPath, htmlDir, nginxConfigPath, {
    DEFAULT_API_URL: toWslPath(localConfigPath),
  })
  assert.ok(
    localPathAsset.includes(`defaultApiUrl = "${embeddedLocalConfig}"`),
    'A local JSON file path must be embedded into the runtime asset',
  )

  resetRuntimeFixture(htmlDir, nginxConfigPath)
  const localConfigAsset = runInjector(injectorPath, htmlDir, nginxConfigPath, {
    DEFAULT_API_URL: `file://${toWslPath(localConfigPath)}`,
  })
  assert.ok(
    localConfigAsset.includes(`defaultApiUrl = "${embeddedLocalConfig}"`),
    'A local JSON config URL must be embedded into the runtime asset',
  )

  resetRuntimeFixture(htmlDir, nginxConfigPath)
  const disabledAsset = runInjector(injectorPath, htmlDir, nginxConfigPath, {
    DEFAULT_API_URL: '',
    API_PROXY_URL: 'https://proxy.example.com/v1///',
    ENABLE_API_PROXY: 'false',
  })
  assert.doesNotMatch(disabledAsset, /__VITE_[A-Z_]+_PLACEHOLDER__/)
  assert.match(disabledAsset, /defaultApiUrl = ""/)
  assert.match(disabledAsset, /proxyAvailable = "false"/)
  assert.match(disabledAsset, /dockerDeployment = "true"/)
  assert.equal(readFileSync(nginxConfigPath, 'utf8').includes('# BEGIN API PROXY'), false)

  resetRuntimeFixture(htmlDir, nginxConfigPath)
  const enabledAsset = runInjector(injectorPath, htmlDir, nginxConfigPath, {
    DEFAULT_API_URL: '',
    API_PROXY_URL: 'https://proxy.example.com/v1///',
    ENABLE_API_PROXY: 'true',
    LOCK_API_PROXY: 'true',
  })
  assert.doesNotMatch(enabledAsset, /__VITE_[A-Z_]+_PLACEHOLDER__/)
  assert.match(enabledAsset, /proxyAvailable = "true"/)
  assert.match(enabledAsset, /proxyLocked = "true"/)
  assert.equal(readFileSync(nginxConfigPath, 'utf8').includes('# BEGIN API PROXY'), true)

  const renderedNginx = nginxTemplate.replaceAll('${API_PROXY_URL}', 'https://proxy.example.com/v1')
  const renderedNginxWithPort = nginxTemplate.replaceAll('${API_PROXY_URL}', 'https://proxy.example.com:8443/v1')
  assert.match(
    renderedNginx,
    /location \/api-proxy\/ \{[\s\S]*?resolver \$\{NGINX_RESOLVER\} ipv6=off valid=30s;[\s\S]*?resolver_timeout 5s;/,
    'The API proxy must use a runtime-configured resolver when proxy_pass contains URI variables',
  )
  assert.match(
    renderedNginxWithPort,
    /proxy_pass https:\/\/proxy\.example\.com:8443\/v1\$uri\$is_args\$args;/,
    'The API proxy must preserve a non-standard HTTPS port in the upstream target',
  )
  assert.match(
    renderedNginx,
    /proxy_ssl_verify on;[\s\S]*?proxy_ssl_trusted_certificate \/etc\/ssl\/certs\/ca-certificates\.crt;/,
    'The API proxy must verify HTTPS upstream certificates',
  )
  assert.match(
    renderedNginx,
    /proxy_set_header Authorization \$http_authorization;/,
    'The API proxy must forward the browser Authorization header',
  )
  assert.match(
    renderedNginx,
    /proxy_set_header Origin "";[\s\S]*?proxy_set_header Connection "";/,
    'The API proxy must remove the browser Origin header before forwarding to same-origin-only upstreams',
  )
  assert.match(
    renderedNginx,
    /proxy_set_header Connection "";[\s\S]*?proxy_set_header X-Real-IP/,
    'The API proxy must keep upstream streaming connections reusable',
  )
  assert.match(renderedNginx, /rewrite \^\/api-proxy\/\(\.\*\)\$ \/\$1 break;/)
  assert.match(renderedNginx, /proxy_pass https:\/\/proxy\.example\.com\/v1\$uri\$is_args\$args;/)
  assert.doesNotMatch(renderedNginx, /proxy_pass https:\/\/proxy\.example\.com\/v1;$/m)
  assert.doesNotMatch(renderedNginx, /v1\/\/;/)

  console.log('Docker runtime contract passed')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}
