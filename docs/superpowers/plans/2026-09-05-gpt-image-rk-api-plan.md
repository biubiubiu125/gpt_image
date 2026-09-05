# gpt_image「RK API 品牌化、默认接口接入与 GHCR 持续交付」Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将项目默认接口、用户可见品牌、仓库引用和 GHCR 发布流程切换到 `gpt_image` / `RK API`，同时保持已有本地数据和内部 provider 兼容。

**Architecture:** 使用一个前端品牌常量模块统一应用名、API 展示名、默认地址和仓库地址；保留内部 `openai` provider 以复用现有 Images/Responses API 链路。GitHub Actions 负责在测试和构建通过后发布固定的 `ghcr.io/biubiubiu125/gpt_image` 多架构镜像。

**Tech Stack:** React 19, Vite, TypeScript, Zustand, Vitest, npm, Docker Buildx, GitHub Actions, GHCR.

**Spec:** `docs/superpowers/specs/2026-09-05-gpt-image-rk-api-design.md`

## Global Constraints

- 用户可见 API 品牌统一为 `RK API`，内部 `openai` provider、`default-openai` profile ID、IndexedDB 名称和 Zustand key 保持不变。
- 默认 API 原始地址为 `https://api.veridiantech1.com`；按现有规则由请求组装逻辑直连到 `https://api.veridiantech1.com/v1/...`。
- 目标仓库为 `https://github.com/biubiubiu125/gpt_image`，目标镜像为 `ghcr.io/biubiubiu125/gpt_image`。
- Docker workflow 必须在测试和构建成功后才推送镜像，并保留 `linux/amd64` 与 `linux/arm64`。
- 不写入 API Key、Token 或其他凭据；不修改已有本地数据存储 key。

---

### Task 1: Add branding constants and update default API behavior

**Files:**
- Create: `src/lib/branding.ts`
- Create: `src/lib/branding.test.ts`
- Modify: `src/lib/apiProfiles.ts:23-36,356-374,744-749`
- Modify: `src/lib/apiProfiles.test.ts` near default profile and provider label tests
- Modify: `deploy/migrate-api-env.envsh:9-12`
- Modify: `deploy/inject-api-url.sh:4-5`
- Modify: `deploy/Dockerfile:26-30` only if a default runtime value is needed
- Modify: `gpt-image-config.example.json`

**Interfaces:**
- Produces `APP_NAME`, `API_BRAND_NAME`, `DEFAULT_API_URL`, and `REPOSITORY_URL` from `src/lib/branding.ts`.
- `createDefaultOpenAIProfile()` returns the existing internal provider `openai`, profile ID `default-openai`, name `RK API`, and the normalized RK API URL.
- `getApiProviderLabel()` returns `RK API` for provider `openai`.

- [x] **Step 1: Write failing tests for the branding and default profile contract**

Add assertions in `src/lib/branding.test.ts` for the exact constants:

```ts
import { describe, expect, it } from 'vitest'
import { API_BRAND_NAME, APP_NAME, DEFAULT_API_URL, REPOSITORY_URL } from './branding'

describe('branding constants', () => {
  it('uses the gpt_image and RK API identity', () => {
    expect(APP_NAME).toBe('gpt_image')
    expect(API_BRAND_NAME).toBe('RK API')
    expect(DEFAULT_API_URL).toBe('https://api.veridiantech1.com')
    expect(REPOSITORY_URL).toBe('https://github.com/biubiubiu125/gpt_image')
  })
})
```

Add the default profile assertions to `src/lib/apiProfiles.test.ts`:

```ts
it('uses RK API as the default OpenAI-compatible profile', () => {
  const profile = createDefaultOpenAIProfile()
  expect(profile).toMatchObject({
    id: DEFAULT_OPENAI_PROFILE_ID,
    name: 'RK API',
    provider: 'openai',
    baseUrl: 'https://api.veridiantech1.com',
  })
})
```

- [x] **Step 2: Run the focused tests and verify they fail for the missing behavior**

Run:

```powershell
npm test -- src/lib/branding.test.ts src/lib/apiProfiles.test.ts
```

Expected: the new branding module import fails and/or the existing default profile still reports the old name and URL.

- [x] **Step 3: Implement the minimum branding and API changes**

Create `src/lib/branding.ts`:

```ts
export const APP_NAME = 'gpt_image'
export const API_BRAND_NAME = 'RK API'
export const DEFAULT_API_URL = 'https://api.veridiantech1.com'
export const REPOSITORY_URL = 'https://github.com/biubiubiu125/gpt_image'
```

In `src/lib/apiProfiles.ts`, import the constants, replace the OpenAI fallback URL with `DEFAULT_API_URL`, use `API_BRAND_NAME` as the default profile name, and return `API_BRAND_NAME` from `getApiProviderLabel()` for provider `openai`. Keep all internal provider IDs and protocol checks unchanged.

Change Docker fallback values to `https://api.veridiantech1.com/v1` so the Nginx proxy receives a complete upstream base path:

```sh
DEFAULT_API_URL=${API_URL:-https://api.veridiantech1.com/v1}
API_PROXY_URL=${API_PROXY_URL:-${API_URL:-https://api.veridiantech1.com/v1}}
```

Update `gpt-image-config.example.json` to use the RK API base URL and `RK API` profile name.

- [x] **Step 4: Run focused tests and inspect the exact normalized values**

Run:

```powershell
npm test -- src/lib/branding.test.ts src/lib/apiProfiles.test.ts
```

Expected: focused tests pass, including the existing profile normalization and preset migration tests.

- [x] **Step 5: Commit the self-contained default API change**

```powershell
git add src/lib/branding.ts src/lib/branding.test.ts src/lib/apiProfiles.ts src/lib/apiProfiles.test.ts deploy/migrate-api-env.envsh deploy/inject-api-url.sh gpt-image-config.example.json
git commit -m "feat: set RK API as the default image provider"
```

### Task 2: Update user-facing product and API branding

**Files:**
- Modify: `index.html`
- Modify: `public/manifest.webmanifest`
- Modify: `public/pwa-icon.svg`
- Modify: `public/sw.js`
- Modify: `src/components/Header.tsx`
- Modify: `src/components/HelpModal.tsx`
- Modify: `src/components/SupportPromptModal.tsx`
- Modify: `src/components/SettingsModal.tsx`
- Modify: `src/components/TaskCard.tsx` only if a visible provider fallback needs changing
- Modify: `src/components/DetailModal.tsx` only for visible protocol copy
- Modify: `src/components/InputBar.tsx`
- Modify: `src/store.ts`
- Modify: `src/lib/db.ts` only if no compatibility-preserving alternative exists; preferred action is no change
- Modify: `src/lib/branding.ts` consumers

**Interfaces:**
- Visible app title is `gpt_image`.
- Visible built-in API label is `RK API`.
- Existing storage identifiers remain unchanged.

- [x] **Step 1: Add a failing visible-label regression test**

Extend `src/lib/branding.test.ts` with the provider label contract through the existing API profile helper:

```ts
it('uses RK API for the built-in provider label', async () => {
  const { getApiProviderLabel } = await import('./apiProfiles')
  expect(getApiProviderLabel({}, 'openai')).toBe('RK API')
})
```

Add a source-level identity check to the test only if a pure helper is needed; do not introduce a DOM test just to assert static document text.

- [x] **Step 2: Run the focused test and confirm the pre-change label fails**

Run:

```powershell
npm test -- src/lib/branding.test.ts
```

Expected: the provider label assertion fails before the Task 1 implementation is present; after Task 1 it passes and protects the public label.

- [x] **Step 3: Update visible copy without changing protocol identifiers**

Use the branding constants in TypeScript/TSX where practical. Apply these exact visible changes:

```text
GPT Image Playground -> gpt_image
OpenAI 兼容接口 -> RK API
OpenAI 最大请求数量 -> RK API 最大请求数量
OpenAI 任务请求超时 -> RK API 任务请求超时
OpenAI 配置 -> RK API 配置
```

Keep technical code identifiers such as `openai`, `isOpenAICompatibleProvider`, `createDefaultOpenAIProfile`, and `api.openai.com` examples that specifically document the generic compatibility protocol unless the text is a product-facing default or link. Replace project-owned links and author-facing text with the target repository while retaining an MIT attribution sentence.

Update:

- `index.html` `<title>` and Apple title.
- `public/manifest.webmanifest` name, short name, and description.
- `public/pwa-icon.svg` title text if it is a visible/accessible product label.
- `public/sw.js` cache name to a new `gpt_image-v<current-version>` value.
- Header, Help, Support, About and Settings links/text.
- Store timeout and Agent error messages that currently expose `OpenAI` as the provider brand.
- Input bar count hint.
- Export filename prefix to `gpt_image-backup`.

Do not rename `gpt-image-playground` in `src/lib/db.ts` or the Zustand persist name; these are compatibility keys.

- [x] **Step 4: Search for visible old branding and run tests**

Run:

```powershell
rg -n -i --glob '!package-lock.json' --glob '!*.test.ts' 'GPT Image Playground|OpenAI 兼容接口|OpenAI 最大|OpenAI 任务|@CookSleep|github.com/CookSleep|cooksleep.github.io|gpt-image-playground-backup' src public index.html
npm test -- src/lib/branding.test.ts src/lib/apiProfiles.test.ts
```

Expected: only intentional internal compatibility identifiers and generic protocol documentation remain; focused tests pass.

### Task 3: Migrate repository identity and documentation

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `wrangler.jsonc`
- Modify: `src/hooks/useVersionCheck.ts`
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `LICENSE` only if the attribution text needs the target fork attribution; preserve original copyright and MIT terms
- Modify: `.github/ISSUE_TEMPLATE/*.yml` only for repository-specific links or product labels
- Modify: `sponsor-presets.json` for the default API/name, but preserve existing preset profile IDs and third-party referral campaign URLs

**Interfaces:**
- Package and deployment identity is `gpt_image`.
- Version check queries `biubiubiu125/gpt_image`.
- README Docker examples use `ghcr.io/biubiubiu125/gpt_image:latest`.

- [x] **Step 1: Replace repository and package references**

Update `package.json` and the root package entry in `package-lock.json` from `gpt-image-playground` to `gpt_image`.

Update `wrangler.jsonc` name to `gpt_image`.

Update `src/hooks/useVersionCheck.ts`:

```ts
const REPO = 'biubiubiu125/gpt_image'
```

Update README repository badges, links, deployment button, Pages examples, Vercel project names, GHCR image references, URL examples, and project heading to the new identity. Replace the default API examples with `https://api.veridiantech1.com`.

- [x] **Step 2: Verify repository and image references**

Run:

```powershell
rg -n -i --glob '!package-lock.json' 'CookSleep/gpt_image_playground|cooksleep/gpt_image_playground|ghcr.io/cooksleep/gpt_image_playground|gpt-image-playground' package.json package-lock.json wrangler.jsonc src README.md AGENTS.md .github deploy public index.html
```

Expected: no stale project-owned repository or image references remain except explicitly preserved compatibility keys, historical release text, generic examples, or third-party referral campaign identifiers that are not repository mirrors.

- [x] **Step 3: Run the build metadata checks**

Run:

```powershell
node -e "const p=require('./package.json'); if(p.name!=='gpt_image') process.exit(1); console.log(p.name)"
node -e "const p=require('./package-lock.json'); if(p.name!=='gpt_image'||p.packages[''].name!=='gpt_image') process.exit(1); console.log(p.name)"
```

Expected: both commands print `gpt_image`.

### Task 4: Make GHCR publish on every main update

**Files:**
- Modify: `.github/workflows/docker.yml`
- Modify: `.github/workflows/deploy.yml` only if repository ownership is hard-coded
- Modify: `.github/workflows/vercel-tag-deploy.yml` only if repository ownership is hard-coded
- Modify: `deploy/Dockerfile` only for build-time defaults already covered by Task 1
- Modify: `README.md` Docker section already covered by Task 3

**Interfaces:**
- Docker workflow publishes `ghcr.io/biubiubiu125/gpt_image`.
- `main` push, `v*` tag push, and manual dispatch are supported.
- `latest` is updated for `main` pushes, release tags, and manual runs.

- [x] **Step 1: Add the workflow contract as a static test script**

Create `scripts/verify-docker-workflow.mjs`:

```js
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
```

Add an npm script:

```json
"verify:docker-workflow": "node scripts/verify-docker-workflow.mjs"
```

- [x] **Step 2: Run the script before changing the workflow and verify it fails**

Run:

```powershell
npm run verify:docker-workflow
```

Expected: failure because the existing workflow lacks the `main` trigger, image name, and test/build gates.

- [x] **Step 3: Update the Docker workflow**

Use this workflow shape:

```yaml
name: Build and Publish Docker Image

on:
  push:
    branches:
      - main
    tags: ['v*']
  workflow_dispatch:

permissions:
  contents: read
  packages: write

jobs:
  docker:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npm test
      - run: npm run build
      - uses: docker/setup-qemu-action@v3
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - id: meta
        uses: docker/metadata-action@v5
        with:
          images: ghcr.io/biubiubiu125/gpt_image
          tags: |
            type=semver,pattern={{version}}
            type=semver,pattern={{major}}.{{minor}}
            type=raw,value=latest
            type=sha
      - uses: docker/build-push-action@v6
        with:
          context: .
          file: deploy/Dockerfile
          platforms: linux/amd64,linux/arm64
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
```

Keep the existing Docker build context and runtime placeholder mechanism. Do not add registry credentials to the repository.

- [x] **Step 4: Run the workflow contract script**

Run:

```powershell
npm run verify:docker-workflow
```

Expected: PASS.

### Task 5: Install dependencies and run full verification

**Files:**
- No source changes expected; inspect all changed files and generated artifacts.

- [x] **Step 1: Install locked dependencies**

Run:

```powershell
npm ci
```

Expected: exit code 0 and `node_modules/.bin/vitest` available.

- [x] **Step 2: Run all tests**

Run:

```powershell
npm test
```

Expected: Vitest exits with code 0 and no failed tests.

- [x] **Step 3: Run the production build**

Run:

```powershell
npm run build
```

Expected: TypeScript and Vite both exit with code 0 and produce `dist/`.

- [x] **Step 4: Run repository and workflow scans**

Run:

```powershell
npm run verify:docker-workflow
rg -n -i --glob '!package-lock.json' --glob '!dist/**' 'CookSleep/gpt_image_playground|cooksleep/gpt_image_playground|ghcr.io/cooksleep/gpt_image_playground|GPT Image Playground' .
git diff --check
git status --short
```

Expected: workflow verification passes, no unexpected old identity remains, whitespace check passes, and only intended source/docs/workflow files are modified. `dist/` and `node_modules/` must remain ignored and untracked.

- [x] **Step 5: Review the final diff**

Run:

```powershell
git diff --stat
git diff -- .github/workflows/docker.yml src/lib/branding.ts src/lib/apiProfiles.ts package.json package-lock.json wrangler.jsonc public/manifest.webmanifest index.html
```

Confirm that internal storage keys and provider IDs were not accidentally renamed, no secrets were added, and the GHCR workflow runs tests before publishing.
