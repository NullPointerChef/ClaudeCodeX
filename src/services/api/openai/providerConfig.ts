import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { getClaudeConfigHomeDir } from '../../../utils/envUtils.js'

export type ProviderName = 'openai' | 'openrouter' | 'siliconflow' | 'custom'

export type ThinkingMode =
  | { type: 'none' }
  | { type: 'reasoning_effort'; level: 'low' | 'medium' | 'high' | 'xhigh' }
  | { type: 'think_tags' }

export interface OpenAIProviderConfig {
  providerName: ProviderName
  baseURL: string
  apiKey: string
  model: string
  thinkingMode: ThinkingMode
  /** When true, use Responses API instead of Chat Completions */
  useResponsesApi?: boolean
}

/** JSON shape persisted to ~/.claude/myclaw/openai-compat.json */
interface PersistedConfig {
  providerName?: ProviderName
  baseURL?: string
  model?: string
  thinkingMode?: ThinkingMode
  keys?: Partial<Record<ProviderName, string>>
}

export const PROVIDER_PRESETS: Record<
  ProviderName,
  { baseURL: string; label: string }
> = {
  openai: {
    baseURL: 'https://api.openai.com/v1',
    label: 'OpenAI',
  },
  openrouter: {
    baseURL: 'https://openrouter.ai/api/v1',
    label: 'OpenRouter',
  },
  siliconflow: {
    baseURL: 'https://api.siliconflow.cn/v1',
    label: 'SiliconFlow',
  },
  custom: {
    baseURL: '',
    label: 'Custom',
  },
}

function getMyClawDir(): string {
  return join(getClaudeConfigHomeDir(), 'myclaw')
}

function getConfigPath(): string {
  return join(getMyClawDir(), 'openai-compat.json')
}

function getCodexHomeDir(): string {
  return process.env.CODEX_HOME || join(homedir(), '.codex')
}

// Module-level mutable config (session cache)
let _config: OpenAIProviderConfig | null = null
let _loaded = false

function readPersistedConfig(): PersistedConfig | null {
  try {
    const raw = readFileSync(getConfigPath(), 'utf-8')
    return JSON.parse(raw) as PersistedConfig
  } catch {
    return null
  }
}

export function getOpenAICompatConfig(): OpenAIProviderConfig | null {
  if (_loaded) return _config

  _loaded = true

  // 1. Try loading persisted config from disk
  const persisted = readPersistedConfig()
  if (
    persisted?.providerName &&
    PROVIDER_PRESETS[persisted.providerName] &&
    persisted.model?.trim()
  ) {
    try {
      const auth = resolveProviderAuthentication(
        persisted.providerName,
        persisted.keys?.[persisted.providerName],
      )
      const apiKey = auth.apiKey || ''
      if (apiKey) {
        _config = {
          providerName: persisted.providerName,
          baseURL:
            auth.useResponsesApi
              ? CODEX_CHATGPT_BASE_URL
              : (persisted.baseURL ||
                PROVIDER_PRESETS[persisted.providerName].baseURL),
          apiKey,
          model: persisted.model,
          thinkingMode: persisted.thinkingMode ?? { type: 'none' },
          useResponsesApi: auth.useResponsesApi,
        }
        return _config
      }
    } catch {
      // Invalid persisted config — fall through
    }
  }

  // 2. Fallback: try env vars (OPENAI_COMPAT_PROVIDER for explicit activation)
  const providerName = process.env
    .OPENAI_COMPAT_PROVIDER as ProviderName | undefined
  if (!providerName) return null
  const preset = PROVIDER_PRESETS[providerName]
  if (!preset) return null
  const auth = resolveProviderAuthentication(providerName)
  const apiKey = auth.apiKey
  if (!apiKey) return null
  _config = {
    providerName,
    baseURL:
      auth.useResponsesApi
        ? CODEX_CHATGPT_BASE_URL
        : (getProviderEnvBaseURL(providerName) || preset.baseURL),
    apiKey,
    model: process.env.OPENAI_COMPAT_MODEL || 'gpt-4o',
    thinkingMode: inferThinkingModeFromEnv(),
    useResponsesApi: auth.useResponsesApi,
  }
  return _config
}

export function setOpenAICompatConfig(
  config: OpenAIProviderConfig | null,
): void {
  _config = config
  _loaded = true
  persistConfig(config)
}

function persistConfig(config: OpenAIProviderConfig | null): void {
  const path = getConfigPath()
  try {
    if (config === null) {
      const existingKeys = readPersistedConfig()?.keys ?? {}
      if (Object.keys(existingKeys).length === 0) {
        unlinkSync(path)
        return
      }

      mkdirSync(getMyClawDir(), { recursive: true })
      writeFileSync(path, JSON.stringify({ keys: existingKeys }, null, 2) + '\n', 'utf-8')
    } else {
      // Load existing keys from disk so we don't lose other providers' keys
      const existingKeys = readPersistedConfig()?.keys ?? {}

      // Only store the key if it didn't come from env
      // (env keys are transient and shouldn't override stored keys)
      if (
        !isProviderKeyFromEnv(config.providerName) &&
        config.apiKey &&
        !(config.providerName === 'openai' && config.useResponsesApi)
      ) {
        existingKeys[config.providerName] = config.apiKey
      }

      const persisted: PersistedConfig = {
        providerName: config.providerName,
        baseURL:
          config.providerName === 'openai' && config.useResponsesApi
            ? PROVIDER_PRESETS.openai.baseURL
            : config.baseURL,
        model: config.model,
        thinkingMode: config.thinkingMode,
        keys: existingKeys,
      }
      mkdirSync(getMyClawDir(), { recursive: true })
      writeFileSync(path, JSON.stringify(persisted, null, 2) + '\n', 'utf-8')
    }
  } catch {
    // Non-fatal: next session just won't have the persisted provider
  }
}

// ─── Remote model list (with disk cache) ─────────────────────────────────────

interface ModelListCache {
  fetchedAt: number // epoch ms
  models: string[]
}

const MODEL_CACHE_TTL = 24 * 60 * 60 * 1000 // 1 day

function getModelCachePath(providerName: string): string {
  return join(getMyClawDir(), `models-${providerName}.json`)
}

function readModelCache(providerName: string): string[] | null {
  try {
    const raw = readFileSync(getModelCachePath(providerName), 'utf-8')
    const cache: ModelListCache = JSON.parse(raw)
    if (Date.now() - cache.fetchedAt < MODEL_CACHE_TTL && cache.models.length > 0) {
      return cache.models
    }
  } catch {
    // miss
  }
  return null
}

function writeModelCache(providerName: string, models: string[]): void {
  try {
    mkdirSync(getMyClawDir(), { recursive: true })
    const cache: ModelListCache = { fetchedAt: Date.now(), models }
    writeFileSync(getModelCachePath(providerName), JSON.stringify(cache) + '\n', 'utf-8')
  } catch {
    // non-fatal
  }
}

type CodexModelVisibility = 'list' | 'hide' | 'none'

interface CodexModelCatalogEntry {
  slug: string
  priority: number
  visibility: CodexModelVisibility
}

interface CodexModelResponseEntry {
  slug?: string
  display_name?: string
  displayName?: string
  priority?: number
  visibility?: string
}

// Visible/hidden picker metadata mirrored from Codex's model catalog.
const CODEX_CHATGPT_MODEL_CATALOG: ReadonlyArray<CodexModelCatalogEntry> = [
  { slug: 'gpt-5.3-codex', priority: 0, visibility: 'list' },
  { slug: 'gpt-5.4', priority: 0, visibility: 'list' },
  { slug: 'gpt-5.2-codex', priority: 3, visibility: 'list' },
  { slug: 'gpt-5.1-codex-max', priority: 4, visibility: 'list' },
  { slug: 'gpt-5.1-codex', priority: 5, visibility: 'hide' },
  { slug: 'gpt-5.2', priority: 6, visibility: 'list' },
  { slug: 'gpt-5.1', priority: 7, visibility: 'hide' },
  { slug: 'gpt-5-codex', priority: 10, visibility: 'hide' },
  { slug: 'gpt-5', priority: 11, visibility: 'hide' },
  { slug: 'gpt-oss-120b', priority: 11, visibility: 'hide' },
  { slug: 'gpt-oss-20b', priority: 11, visibility: 'hide' },
  { slug: 'gpt-5.1-codex-mini', priority: 12, visibility: 'list' },
  { slug: 'gpt-5-codex-mini', priority: 13, visibility: 'hide' },
]

const CODEX_CHATGPT_MODELS = CODEX_CHATGPT_MODEL_CATALOG
  .filter(model => model.visibility === 'list')
  .map(model => model.slug)

const CODEX_CHATGPT_MODEL_ORDER = new Map(
  CODEX_CHATGPT_MODEL_CATALOG.map((model, index) => [model.slug, index]),
)

const CODEX_CHATGPT_MODEL_BY_SLUG = new Map(
  CODEX_CHATGPT_MODEL_CATALOG.map(model => [model.slug, model]),
)

function normalizeCodexModelVisibility(
  value: string | undefined,
): CodexModelVisibility | null {
  if (value === undefined) return null
  switch (value.toLowerCase()) {
    case 'list':
    case 'hide':
    case 'none':
      return value.toLowerCase() as CodexModelVisibility
    default:
      return null
  }
}

function sortCodexPickerSlugs(slugs: string[]): string[] {
  return Array.from(new Set(slugs))
    .map((slug, index) => {
      const catalog = CODEX_CHATGPT_MODEL_BY_SLUG.get(slug)
      return {
        slug,
        index,
        priority: catalog?.priority ?? Number.MAX_SAFE_INTEGER,
        visibility: catalog?.visibility ?? 'list',
        rank: CODEX_CHATGPT_MODEL_ORDER.get(slug) ?? Number.MAX_SAFE_INTEGER,
      }
    })
    .filter(model => model.visibility === 'list')
    .sort((a, b) =>
      a.priority - b.priority ||
      a.rank - b.rank ||
      a.index - b.index ||
      a.slug.localeCompare(b.slug),
    )
    .map(model => model.slug)
}

function normalizeCodexModelResponse(
  models: CodexModelResponseEntry[],
): string[] {
  const normalized = models
    .map((model, index) => {
      const slug = model.slug ?? model.display_name ?? model.displayName ?? ''
      if (!slug) return null

      const catalog = CODEX_CHATGPT_MODEL_BY_SLUG.get(slug)
      return {
        slug,
        index,
        priority:
          typeof model.priority === 'number'
            ? model.priority
            : (catalog?.priority ?? Number.MAX_SAFE_INTEGER),
        visibility:
          normalizeCodexModelVisibility(model.visibility) ??
          catalog?.visibility ??
          'list',
        rank: CODEX_CHATGPT_MODEL_ORDER.get(slug) ?? Number.MAX_SAFE_INTEGER,
      }
    })
    .filter((model): model is NonNullable<typeof model> => model !== null)
    .filter(model => model.visibility === 'list')
    .sort((a, b) =>
      a.priority - b.priority ||
      a.rank - b.rank ||
      a.index - b.index ||
      a.slug.localeCompare(b.slug),
    )
    .map(model => model.slug)

  return normalized.length > 0 ? normalized : CODEX_CHATGPT_MODELS
}

/**
 * Fetch available models from a provider's /models endpoint.
 * Uses disk cache (1-day TTL) in ~/.claude/myclaw/.
 * Pass `forceRefresh: true` to bypass cache.
 */
export async function fetchProviderModels(
  providerName: ProviderName,
  opts?: { forceRefresh?: boolean },
): Promise<string[]> {
  const auth = resolveProviderAuthentication(
    providerName,
    getStoredKeyForProvider(providerName),
  )

  // For OpenAI with Codex ChatGPT auth, use the Codex picker catalog.
  // The chatgpt backend can return richer model metadata than /v1/models.
  if (providerName === 'openai' && auth.useResponsesApi) {
    if (!opts?.forceRefresh) {
      const cached = readModelCache('openai-codex')
      if (cached) return cached
    }
    // Try fetching from the chatgpt backend, then fall back to the local
    // Codex picker catalog if the request fails.
    const token = readCodexAccessToken()
    if (token) {
      try {
        const resp = await fetch(`${CODEX_CHATGPT_BASE_URL}/models`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(10_000),
        })
        if (resp.ok) {
          const body = (await resp.json()) as {
            models?: CodexModelResponseEntry[]
            data?: Array<{ id: string }>
          }
          let models: string[]
          if (body.models) {
            // Codex-style response includes picker metadata such as
            // visibility and priority, so preserve that when present.
            models = normalizeCodexModelResponse(body.models)
          } else if (body.data) {
            // Standard OpenAI-style response
            models = sortCodexPickerSlugs(body.data.map(m => m.id))
          } else {
            models = CODEX_CHATGPT_MODELS
          }
          if (models.length > 0) {
            writeModelCache('openai-codex', models)
            return models
          }
        }
      } catch {
        // Fall through to hardcoded list
      }
    }
    writeModelCache('openai-codex', CODEX_CHATGPT_MODELS)
    return CODEX_CHATGPT_MODELS
  }

  if (!opts?.forceRefresh) {
    const cached = readModelCache(providerName)
    if (cached) return cached
  }

  const preset = PROVIDER_PRESETS[providerName]
  if (!preset?.baseURL) return []

  const apiKey = auth.apiKey
  if (!apiKey) return []

  const baseURL = getProviderEnvBaseURL(providerName) || preset.baseURL

  try {
    // SiliconFlow supports ?sub_type=chat; others just use /models
    const url = providerName === 'siliconflow'
      ? `${baseURL}/models?sub_type=chat`
      : `${baseURL}/models`

    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    })
    if (!resp.ok) return []

    const body = (await resp.json()) as { data?: Array<{ id: string }> }
    const models = (body.data ?? []).map(m => m.id).sort()

    if (models.length > 0) {
      writeModelCache(providerName, models)
    }
    return models
  } catch {
    // Network error — fall back to cache even if expired
    return readModelCache(providerName) ?? []
  }
}

/** Read the stored API key for a specific provider from disk config. */
export function getStoredKeyForProvider(name: ProviderName): string | undefined {
  try {
    const raw = readFileSync(getConfigPath(), 'utf-8')
    const persisted: PersistedConfig = JSON.parse(raw)
    return (
      persisted.keys?.[name] ??
      (name === 'openai' ? readCodexApiKey() ?? undefined : undefined)
    )
  } catch {
    return name === 'openai' ? readCodexApiKey() ?? undefined : undefined
  }
}

/** Persist an API key for a specific provider without changing the active config. */
export function storeKeyForProvider(name: ProviderName, key: string): void {
  const path = getConfigPath()
  try {
    const persisted = readPersistedConfig() ?? {}
    persisted.keys = persisted.keys ?? {}
    persisted.keys[name] = key
    mkdirSync(getMyClawDir(), { recursive: true })
    writeFileSync(path, JSON.stringify(persisted, null, 2) + '\n', 'utf-8')
  } catch {
    // Non-fatal
  }
}

// ─── Codex CLI auth integration ───────────────────────────────────────────────

const CODEX_AUTH_PATH = () => join(getCodexHomeDir(), 'auth.json')
const CODEX_REFRESH_URL = 'https://auth.openai.com/oauth/token'
const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const CODEX_CHATGPT_BASE_URL = 'https://chatgpt.com/backend-api/codex'

export interface CodexAuthInfo {
  accessToken: string
  refreshToken: string
  authMode: 'chatgpt' | 'api_key'
}

export interface ProviderAuthenticationResolution {
  apiKey?: string
  useResponsesApi: boolean
}

function getProviderEnvApiKey(providerName: ProviderName): string | undefined {
  if (providerName === 'siliconflow') {
    return process.env.SILICONFLOW_API_KEY || process.env.OPENAI_COMPAT_API_KEY
  }

  return process.env.OPENAI_COMPAT_API_KEY
}

function getProviderEnvBaseURL(providerName: ProviderName): string | undefined {
  if (providerName === 'siliconflow') {
    return process.env.SILICONFLOW_BASE_URL || process.env.OPENAI_COMPAT_BASE_URL
  }

  return process.env.OPENAI_COMPAT_BASE_URL
}

function isProviderKeyFromEnv(providerName: ProviderName): boolean {
  if (providerName === 'siliconflow') {
    return Boolean(process.env.SILICONFLOW_API_KEY || process.env.OPENAI_COMPAT_API_KEY)
  }

  return Boolean(process.env.OPENAI_COMPAT_API_KEY)
}

function parseJwtPayload(jwt: string): Record<string, unknown> | null {
  try {
    return JSON.parse(
      Buffer.from(jwt.split('.')[1]!, 'base64url').toString(),
    )
  } catch {
    return null
  }
}

function isJwtExpired(jwt: string): boolean {
  const payload = parseJwtPayload(jwt) as { exp?: number } | null
  if (!payload?.exp) return false
  return payload.exp * 1000 < Date.now()
}

function readCodexApiKey(): string | null {
  const auth = readCodexAuth()
  if (auth?.authMode === 'api_key') {
    return auth.accessToken
  }
  return null
}

export function resolveProviderAuthentication(
  providerName: ProviderName,
  storedKey?: string,
): ProviderAuthenticationResolution {
  if (providerName !== 'openai') {
    const envApiKey = getProviderEnvApiKey(providerName)
    if (envApiKey) {
      return { apiKey: envApiKey, useResponsesApi: false }
    }
    return { apiKey: storedKey, useResponsesApi: false }
  }

  const codexAuth = readCodexAuth()
  if (codexAuth?.authMode === 'chatgpt') {
    return {
      apiKey: codexAuth.accessToken,
      useResponsesApi: true,
    }
  }

  const envApiKey = process.env.OPENAI_COMPAT_API_KEY
  if (envApiKey) {
    return { apiKey: envApiKey, useResponsesApi: false }
  }

  return {
    apiKey: storedKey || readCodexApiKey() || undefined,
    useResponsesApi: false,
  }
}

/**
 * Read full auth info from Codex CLI's ~/.codex/auth.json.
 */
export function readCodexAuth(): CodexAuthInfo | null {
  try {
    const raw = readFileSync(CODEX_AUTH_PATH(), 'utf-8')
    const auth = JSON.parse(raw) as {
      auth_mode?: string
      OPENAI_API_KEY?: string
      tokens?: {
        access_token?: string
        refresh_token?: string
        id_token?: string
      }
    }

    // API key mode
    if (auth.auth_mode === 'api_key' && auth.OPENAI_API_KEY) {
      return {
        accessToken: auth.OPENAI_API_KEY,
        refreshToken: '',
        authMode: 'api_key',
      }
    }

    // ChatGPT OAuth mode
    const token = auth.tokens?.access_token
    if (!token) return null

    return {
      accessToken: token,
      refreshToken: auth.tokens?.refresh_token ?? '',
      authMode: 'chatgpt',
    }
  } catch {
    return null
  }
}

/**
 * Read the access_token from Codex CLI, auto-refreshing if expired.
 */
function readCodexAccessToken(): string | null {
  const auth = readCodexAuth()
  if (!auth) return null
  if (auth.authMode === 'api_key') return auth.accessToken
  if (!isJwtExpired(auth.accessToken)) return auth.accessToken
  // Token expired — try synchronous refresh not possible, return null
  // (async refresh happens in ensureCodexToken)
  return null
}

/**
 * Refresh the Codex OAuth token and update auth.json.
 */
export async function refreshCodexToken(): Promise<CodexAuthInfo | null> {
  const auth = readCodexAuth()
  if (!auth || auth.authMode !== 'chatgpt' || !auth.refreshToken) return null

  try {
    const resp = await fetch(CODEX_REFRESH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: CODEX_CLIENT_ID,
        grant_type: 'refresh_token',
        refresh_token: auth.refreshToken,
      }),
      signal: AbortSignal.timeout(10_000),
    })

    if (!resp.ok) return null

    const data = (await resp.json()) as {
      access_token?: string
      refresh_token?: string
      id_token?: string
    }

    if (!data.access_token) return null

    // Update auth.json on disk
    try {
      const raw = readFileSync(CODEX_AUTH_PATH(), 'utf-8')
      const onDisk = JSON.parse(raw) as Record<string, unknown>
      const tokens = (onDisk.tokens ?? {}) as Record<string, unknown>
      if (data.access_token) tokens.access_token = data.access_token
      if (data.refresh_token) tokens.refresh_token = data.refresh_token
      if (data.id_token) tokens.id_token = data.id_token
      onDisk.tokens = tokens
      onDisk.last_refresh = new Date().toISOString()
      writeFileSync(CODEX_AUTH_PATH(), JSON.stringify(onDisk, null, 2), 'utf-8')
    } catch {
      // Non-fatal: token is still usable even if we can't persist
    }

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? auth.refreshToken,
      authMode: 'chatgpt',
    }
  } catch {
    return null
  }
}

/**
 * Get a valid Codex access token, refreshing if needed.
 */
export async function ensureCodexToken(): Promise<string | null> {
  const auth = readCodexAuth()
  if (!auth) return null
  if (auth.authMode === 'api_key') return auth.accessToken
  if (!isJwtExpired(auth.accessToken)) return auth.accessToken

  // Token expired — try to refresh
  const refreshed = await refreshCodexToken()
  return refreshed?.accessToken ?? null
}

/**
 * Check if the current OpenAI provider config uses Codex ChatGPT auth.
 * When true, the Responses API should be used instead of Chat Completions.
 */
export function isCodexChatgptAuth(): boolean {
  const auth = readCodexAuth()
  return auth?.authMode === 'chatgpt'
}

/**
 * Get the appropriate base URL for OpenAI provider.
 * ChatGPT OAuth tokens must go through chatgpt.com/backend-api/codex.
 */
export function getCodexBaseURL(): string {
  const auth = readCodexAuth()
  if (auth?.authMode === 'chatgpt') return CODEX_CHATGPT_BASE_URL
  return PROVIDER_PRESETS.openai.baseURL
}

function inferThinkingModeFromEnv(): ThinkingMode {
  const mode = process.env.OPENAI_COMPAT_THINKING_MODE
  if (mode === 'reasoning_effort') {
    const level = (process.env.OPENAI_COMPAT_REASONING_EFFORT || 'high') as
      | 'low'
      | 'medium'
      | 'high'
    return { type: 'reasoning_effort', level }
  }
  if (mode === 'think_tags') {
    return { type: 'think_tags' }
  }
  return { type: 'none' }
}
