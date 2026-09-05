# gpt_image「RK API 品牌化、默认接口接入与 GHCR 持续交付」设计

## 目标

将当前 `gpt-image-playground` 二次开发为 `gpt_image`，把默认 OpenAI-compatible（OpenAI 兼容）接口切换为 `https://api.veridiantech1.com`，在用户可见位置统一显示 `RK API`，并让目标仓库每次更新 `main` 分支时自动构建并发布 GHCR Docker 镜像。

## 范围

### 1. 用户可见品牌

- 页面标题、PWA 名称、顶部标题、About 页面、任务卡片来源、详情页来源和相关提示统一使用 `gpt_image` 或 `RK API`。
- 设置页的内置接口选项显示为 `RK API`。
- 与接口能力有关的技术说明可以继续保留 `Images API`、`Responses API`、`Codex CLI` 等协议术语。
- 内部 provider 值 `openai`、配置 ID `default-openai`、函数名和历史数据字段不改，保证已有配置、任务和 Agent 逻辑兼容。
- 保留原 MIT 许可证要求的来源说明，但链接和产品主入口改为目标仓库。

### 2. 默认 API

- 默认 API 原始地址使用 `https://api.veridiantech1.com`。
- 现有 URL 规范化规则继续生效：默认配置保存原始域名 `https://api.veridiantech1.com`，直连请求由现有 URL 组装逻辑使用 `https://api.veridiantech1.com/v1/...`。
- 默认 profile 的名称为 `RK API`。
- 通过 `VITE_DEFAULT_API_URL`、`DEFAULT_API_URL` 或导入 JSON 显式配置的值仍优先于内置默认值。
- Docker API 代理的默认目标显式使用 `https://api.veridiantech1.com/v1`，因为 Nginx 代理路径不会替前端请求自动补 `/v1`。

### 3. 仓库与发布

- GitHub 主仓库统一使用 `https://github.com/biubiubiu125/gpt_image`。
- 版本检查、反馈链接、页面仓库链接、部署按钮、README 示例和工作流中的仓库判断统一切换。
- GHCR 镜像统一使用 `ghcr.io/biubiubiu125/gpt_image`。
- Docker workflow 在 `main` 分支 push、版本标签和手动触发时运行。
- `main` 分支更新推送 `latest` 和 commit SHA 标签；`v*` 标签额外推送 semver 版本标签。
- 保留 `linux/amd64` 和 `linux/arm64` 多架构构建。
- 镜像推送前执行依赖安装、测试和生产构建；验证失败时不推送镜像。

### 4. 数据与升级兼容

- 不修改 IndexedDB 数据库名 `gpt-image-playground`，避免已有任务和图片丢失。
- 不修改 Zustand 持久化 key，避免已有设置迁移失败。
- 不修改导出 ZIP manifest 版本和内部 provider 标识。
- 保持 `sponsor-presets.json` 中既有预置 profile ID 和第三方推广链接稳定；这些 ID 可能被已部署用户的 API Key、激活配置和历史任务引用，推广链接也不是仓库镜像地址。
- 更新 Service Worker 缓存版本，确保新品牌和新构建可以替换旧缓存。
- 导出文件名改为 `gpt_image-backup_...zip`，不影响 ZIP 导入。

## 方案结构

### 品牌常量

新增 `src/lib/branding.ts`，集中保存前端可复用的应用名、API 展示名、目标仓库地址和默认 API 地址。`apiProfiles.ts`、Header、About、版本检查等模块复用这些常量；Shell、JSON、GitHub Actions 和 README 使用各自运行环境可用的等值字面量。

### API 配置

`src/lib/apiProfiles.ts` 继续以 `openai` 作为协议 provider，但默认基地址和默认 profile 名称切换到 RK API。`getApiProviderLabel()` 对内置 `openai` provider 返回 `RK API`，这样设置页、任务卡片和详情页都能保持一致。

### CI/CD

Docker 工作流增加 `main` push 触发，并在 Docker build 前增加 Node 依赖、单元测试和构建步骤。GHCR metadata 使用固定目标镜像名；标签规则区分普通提交、版本标签和手动运行。

### 文档与身份

更新 `package.json`、`package-lock.json`、`wrangler.jsonc`、PWA manifest、HTML title、Service Worker、README 和用户可见仓库链接。保留第三方 API 兼容能力说明，不把协议实现误改成新的 provider。

## 错误处理

- 默认接口地址只影响没有显式配置时的 profile。
- 显式 API 配置、导入配置和 URL 参数优先级保持不变。
- GHCR 发布失败由 GitHub Actions 直接失败，不吞掉测试、构建或推送错误。
- 不新增真实 API Key、Token 或固定凭据。

## 验收标准

1. 新安装页面的默认 profile 名为 `RK API`，默认 base URL 保存为 `https://api.veridiantech1.com`，实际请求地址为 `https://api.veridiantech1.com/v1/...`。
2. 用户可见的内置 provider、任务来源、详情来源和超时提示显示 `RK API`，内部 provider 仍为 `openai`。
3. 页面标题、PWA 名称、仓库链接、版本检查和导出文件名使用 `gpt_image` / 目标仓库。
4. `npm test` 和 `npm run build` 通过。
5. Docker workflow 的触发器、检查步骤、镜像名和标签规则符合设计。
6. 全局搜索确认没有遗漏的旧主仓库、旧 GHCR 镜像名或旧产品品牌；保留的数据 key 和 provider 内部标识有明确理由。
