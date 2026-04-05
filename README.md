# FrankenClaude

基于 [claude-code-best](https://github.com/claude-code-best/claude-code) 的 Claude Code CLI 扩展，新增了对 **Codex CLI 本地配置**和 **SiliconFlow** 的支持，可接入更多模型服务商。

> **免责声明**：本项目仅供个人学习与技术研究，使用前请确保你已遵守各平台（Anthropic、OpenAI、SiliconFlow 等）的服务条款。本项目不对任何因使用本软件导致的账号封禁、法律责任或其他损失负责。

## 新增功能

### Codex CLI 本地配置读取

若本机已安装并配置 [Codex CLI](https://github.com/openai/codex)，MyClaw 会自动读取其本地配置文件（`~/.codex/auth.json`），免去重复填写 API Key 的步骤。支持 API Key 模式与 OAuth Token 模式。

### SiliconFlow 支持

新增硅基流动作为内置 provider，填入 API Key 即可使用国内模型服务。

### 配置持久化

Provider 配置（含各 provider 的 key）持久化至 `~/.claude/myclaw/openai-compat.json`，切换 provider 无需重复输入。

---

## 环境要求

- [Bun](https://bun.sh/) >= 1.3.11（建议执行 `bun upgrade` 保持最新）

---

## 安装

```bash
git clone <repo>
cd claude-code-good
bun install
```

---

## 使用

### 方式一：读取 Codex CLI 本地配置

**前提**：本机已安装并配置过 Codex CLI（`~/.codex/auth.json` 存在）。

```bash
bun run dev
```

启动后执行 `/model`，选择 OpenAI provider，程序会自动读取本地 Codex 配置，无需手动输入 key。

---

### 方式二：SiliconFlow

```bash
bun run dev
```

启动后执行 `/model`，选择 **SiliconFlow**，输入 API Key 后选择模型即可。配置自动保存，下次启动无需重新输入。

也可通过环境变量临时使用：

```bash
SILICONFLOW_API_KEY=your_key bun run dev
```

---

### 方式三：OpenAI / OpenRouter / 自定义

同上，启动后执行 `/model` 选择对应 provider，填入 API Key。自定义 provider 可手动填写 Base URL（兼容 OpenAI Chat Completions API 的服务均可）。

---

### 环境变量

| 变量 | 说明 |
|------|------|
| `SILICONFLOW_API_KEY` | SiliconFlow API Key |
| `SILICONFLOW_BASE_URL` | SiliconFlow Base URL（默认 `https://api.siliconflow.cn/v1`） |
| `OPENAI_COMPAT_API_KEY` | 通用 API Key |
| `OPENAI_COMPAT_BASE_URL` | 通用 Base URL |
| `OPENAI_COMPAT_PROVIDER` | Provider 名称（`openai` / `openrouter` / `siliconflow` / `custom`） |
| `OPENAI_COMPAT_MODEL` | 模型名称 |
| `CODEX_HOME` | 覆盖 Codex 配置目录（默认 `~/.codex`） |

---

## 构建

```bash
bun run build        # 输出到 dist/，入口 dist/cli.js
node dist/cli.js     # Node.js 运行
bun dist/cli.js      # Bun 运行
```

---

## 开发命令

```bash
bun run dev          # 开发模式
bun run lint         # Biome lint
bun run lint:fix     # 自动修复
bun test             # 运行测试
```

---

## 许可证

本项目基于 [claude-code-best/claude-code](https://github.com/claude-code-best/claude-code) 二次开发，仅供学习研究用途，不得用于商业目的。
