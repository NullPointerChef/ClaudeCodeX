import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
	fetchProviderModels,
	getStoredKeyForProvider,
	resolveProviderAuthentication,
	setOpenAICompatConfig,
	storeKeyForProvider,
} from '../providerConfig.js'

const ORIGINAL_HOME = process.env.HOME
const ORIGINAL_CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR
const ORIGINAL_CODEX_HOME = process.env.CODEX_HOME
const ORIGINAL_OPENAI_COMPAT_API_KEY = process.env.OPENAI_COMPAT_API_KEY
const ORIGINAL_SILICONFLOW_API_KEY = process.env.SILICONFLOW_API_KEY
const ORIGINAL_SILICONFLOW_BASE_URL = process.env.SILICONFLOW_BASE_URL
const ORIGINAL_FETCH = globalThis.fetch

function createTempAuthHome(): string {
	const home = mkdtempSync(join(tmpdir(), 'myclaw-openai-provider-'))
	const codexDir = join(home, '.codex')

	mkdirSync(codexDir, { recursive: true })
	writeFileSync(
		join(codexDir, 'auth.json'),
		JSON.stringify({
			auth_mode: 'chatgpt',
			tokens: {
				access_token: 'codex-access-token',
			},
		}),
	)

	process.env.HOME = home
	process.env.CLAUDE_CONFIG_DIR = join(home, '.claude')
	process.env.CODEX_HOME = codexDir
	delete process.env.OPENAI_COMPAT_API_KEY
	delete process.env.SILICONFLOW_API_KEY
	delete process.env.SILICONFLOW_BASE_URL

	return home
}

async function importFreshProviderConfig() {
	return import(`../providerConfig.js?test=${Date.now()}-${Math.random()}`)
}

describe('fetchProviderModels', () => {
	let tempHome: string | null = null

	beforeEach(() => {
		tempHome = createTempAuthHome()
	})

	afterEach(() => {
		globalThis.fetch = ORIGINAL_FETCH
		process.env.HOME = ORIGINAL_HOME
		process.env.CLAUDE_CONFIG_DIR = ORIGINAL_CLAUDE_CONFIG_DIR
		process.env.CODEX_HOME = ORIGINAL_CODEX_HOME
		if (ORIGINAL_OPENAI_COMPAT_API_KEY === undefined) {
			delete process.env.OPENAI_COMPAT_API_KEY
		} else {
			process.env.OPENAI_COMPAT_API_KEY = ORIGINAL_OPENAI_COMPAT_API_KEY
		}
		if (ORIGINAL_SILICONFLOW_API_KEY === undefined) {
			delete process.env.SILICONFLOW_API_KEY
		} else {
			process.env.SILICONFLOW_API_KEY = ORIGINAL_SILICONFLOW_API_KEY
		}
		if (ORIGINAL_SILICONFLOW_BASE_URL === undefined) {
			delete process.env.SILICONFLOW_BASE_URL
		} else {
			process.env.SILICONFLOW_BASE_URL = ORIGINAL_SILICONFLOW_BASE_URL
		}

		if (tempHome) {
			rmSync(tempHome, { recursive: true, force: true })
		}
	})

	test('filters hidden Codex models and sorts visible picker models by priority', async () => {
		globalThis.fetch = mock(async () => new Response(JSON.stringify({
			models: [
				{
					slug: 'gpt-5.2',
					display_name: 'gpt-5.2',
					priority: 6,
					visibility: 'list',
				},
				{
					slug: 'gpt-5.1-codex-mini',
					display_name: 'gpt-5.1-codex-mini',
					priority: 12,
					visibility: 'list',
				},
				{
					slug: 'gpt-5.4',
					display_name: 'gpt-5.4',
					priority: 0,
					visibility: 'list',
				},
				{
					slug: 'gpt-4.1-codex',
					display_name: 'gpt-4.1-codex',
					priority: 40,
					visibility: 'hide',
				},
				{
					slug: 'gpt-5.3-codex',
					display_name: 'gpt-5.3-codex',
					priority: 0,
					visibility: 'list',
				},
			],
		}), { status: 200 })) as typeof fetch

		const models = await fetchProviderModels('openai', {
			forceRefresh: true,
		})

		expect(models).toEqual([
			'gpt-5.3-codex',
			'gpt-5.4',
			'gpt-5.2',
			'gpt-5.1-codex-mini',
		])
	})

	test('falls back to the Codex picker defaults when the chatgpt backend is unavailable', async () => {
		globalThis.fetch = mock(async () => {
			throw new Error('network unavailable')
		}) as typeof fetch

		const models = await fetchProviderModels('openai', {
			forceRefresh: true,
		})

		expect(models).toEqual([
			'gpt-5.3-codex',
			'gpt-5.4',
			'gpt-5.2-codex',
			'gpt-5.1-codex-max',
			'gpt-5.2',
			'gpt-5.1-codex-mini',
		])
	})

	test('does not treat a ChatGPT OAuth access token as a stored OpenAI API key', () => {
		expect(getStoredKeyForProvider('openai')).toBeUndefined()
	})

	test('prefers ChatGPT auth over a previously stored OpenAI API key for the OpenAI provider', () => {
		expect(resolveProviderAuthentication('openai', 'stored-openai-key')).toEqual({
			apiKey: 'codex-access-token',
			useResponsesApi: true,
		})
	})

	test('prefers ChatGPT auth over OPENAI_COMPAT_API_KEY for the OpenAI provider', () => {
		process.env.OPENAI_COMPAT_API_KEY = 'env-openai-key'

		expect(resolveProviderAuthentication('openai', 'stored-openai-key')).toEqual({
			apiKey: 'codex-access-token',
			useResponsesApi: true,
		})
	})

	test('still uses the Codex picker path for OpenAI when OPENAI_COMPAT_API_KEY is set', async () => {
		process.env.OPENAI_COMPAT_API_KEY = 'env-openai-key'
		globalThis.fetch = mock(async () => new Response(JSON.stringify({
			models: [
				{
					slug: 'gpt-5.2',
					display_name: 'gpt-5.2',
					priority: 6,
					visibility: 'list',
				},
				{
					slug: 'gpt-5.3-codex',
					display_name: 'gpt-5.3-codex',
					priority: 0,
					visibility: 'list',
				},
			],
		}), { status: 200 })) as typeof fetch

		const models = await fetchProviderModels('openai', {
			forceRefresh: true,
		})

		expect(models).toEqual([
			'gpt-5.3-codex',
			'gpt-5.2',
		])
	})

	test('does not persist the ChatGPT OAuth access token into openai-compat.json', () => {
		setOpenAICompatConfig({
			providerName: 'openai',
			baseURL: 'https://chatgpt.com/backend-api/codex',
			apiKey: 'codex-access-token',
			model: 'gpt-5.3-codex',
			thinkingMode: { type: 'reasoning_effort', level: 'high' },
			useResponsesApi: true,
		})

		const persisted = JSON.parse(
			readFileSync(
				join(process.env.CLAUDE_CONFIG_DIR!, 'myclaw', 'openai-compat.json'),
				'utf-8',
			),
		) as {
			keys?: Record<string, string>
		}

		expect(persisted.keys?.openai).toBeUndefined()
	})

	test('does not activate SiliconFlow on next startup when only a stored key exists', async () => {
		storeKeyForProvider('siliconflow', 'siliconflow-key')

		const freshProviderConfig = await importFreshProviderConfig()

		expect(freshProviderConfig.getOpenAICompatConfig()).toBeNull()
		expect(freshProviderConfig.getStoredKeyForProvider('siliconflow')).toBe(
			'siliconflow-key',
		)
	})

	test('preserves the stored SiliconFlow key when switching back to Anthropic', async () => {
		setOpenAICompatConfig({
			providerName: 'siliconflow',
			baseURL: 'https://api.siliconflow.cn/v1',
			apiKey: 'siliconflow-key',
			model: 'deepseek-ai/DeepSeek-V3',
			thinkingMode: { type: 'none' },
		})

		setOpenAICompatConfig(null)

		const freshProviderConfig = await importFreshProviderConfig()

		expect(freshProviderConfig.getOpenAICompatConfig()).toBeNull()
		expect(freshProviderConfig.getStoredKeyForProvider('siliconflow')).toBe(
			'siliconflow-key',
		)
	})

	test('prefers SILICONFLOW_API_KEY over OPENAI_COMPAT_API_KEY for siliconflow provider', () => {
		process.env.OPENAI_COMPAT_API_KEY = 'generic-openai-compat-key'
		process.env.SILICONFLOW_API_KEY = 'siliconflow-only-key'

		expect(resolveProviderAuthentication('siliconflow', 'stored-sf-key')).toEqual({
			apiKey: 'siliconflow-only-key',
			useResponsesApi: false,
		})
	})

	test('uses SILICONFLOW_BASE_URL only for siliconflow provider model fetch', async () => {
		process.env.SILICONFLOW_API_KEY = 'siliconflow-only-key'
		process.env.SILICONFLOW_BASE_URL = 'https://sf.example/v1'

		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			expect(String(input)).toBe('https://sf.example/v1/models?sub_type=chat')
			return new Response(JSON.stringify({ data: [{ id: 'foo/model' }] }), {
				status: 200,
			})
		}) as typeof fetch

		const models = await fetchProviderModels('siliconflow', {
			forceRefresh: true,
		})

		expect(models).toEqual(['foo/model'])
	})
})
