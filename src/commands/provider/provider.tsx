import chalk from 'chalk'
import * as React from 'react'
import { Select } from '../../components/CustomSelect/select.js'
import Text from '../../ink/components/Text.js'
import type { LocalJSXCommandCall, CommandResultDisplay } from '../../types/command.js'
import {
	getOpenAICompatConfig,
	setOpenAICompatConfig,
	fetchProviderModels,
	getStoredKeyForProvider,
	storeKeyForProvider,
	PROVIDER_PRESETS,
	getCodexBaseURL,
	readCodexAuth,
	resolveProviderAuthentication,
	type ProviderName,
	type OpenAIProviderConfig,
	type ThinkingMode,
} from '../../services/api/openai/providerConfig.js'
import { scheduleResponsesStartupWebSocketPrewarm } from '../../services/api/openai/responsesClient.js'
import { inferThinkingMode } from '../../services/api/openai/thinkingHandler.js'
import { useInput, Box } from '../../ink.js'

type OnDone = (
	result?: string,
	options?: { display?: CommandResultDisplay },
) => void

type ProviderValue = ProviderName | 'anthropic'

function getProviderOptions(): Array<{
	label: string
	value: ProviderValue
	description: string
}> {
	const codexAuth = readCodexAuth()
	const openaiDesc = codexAuth?.authMode === 'chatgpt'
		? 'Codex login (ChatGPT Plus)'
		: codexAuth?.authMode === 'api_key'
			? 'Codex login (API key)'
			: 'api.openai.com'

	return [
		{ label: 'Anthropic', value: 'anthropic', description: 'Default Anthropic API' },
		{ label: 'OpenAI', value: 'openai', description: openaiDesc },
		{ label: 'OpenRouter', value: 'openrouter', description: 'openrouter.ai' },
		{ label: 'SiliconFlow', value: 'siliconflow', description: 'api.siliconflow.cn' },
		{ label: 'Custom', value: 'custom', description: 'Custom OpenAI-compatible endpoint' },
	]
}

/** Resolve API key for a provider: env → disk → undefined */
function resolveApiKey(providerName: ProviderName): string | undefined {
	const auth = resolveProviderAuthentication(
		providerName,
		getStoredKeyForProvider(providerName),
	)
	return auth.useResponsesApi ? undefined : auth.apiKey
}

function hasProviderAuthentication(providerName: ProviderName): boolean {
	const auth = resolveProviderAuthentication(
		providerName,
		getStoredKeyForProvider(providerName),
	)
	return auth.useResponsesApi || !!auth.apiKey
}

// ─── API key input (simple interactive text field) ────────────────────────────

function ApiKeyInput({
	providerName,
	onKey,
	onCancel,
}: {
	providerName: ProviderName
	onKey: (key: string) => void
	onCancel: () => void
}) {
	const [value, setValue] = React.useState('')

	useInput((input, key) => {
		if (key.escape) {
			onCancel()
			return
		}
		if (key.return) {
			const trimmed = value.trim()
			if (trimmed) {
				storeKeyForProvider(providerName, trimmed)
				onKey(trimmed)
			}
			return
		}
		if (key.backspace || key.delete) {
			setValue((v) => v.slice(0, -1))
			return
		}
		if (input && !key.ctrl && !key.meta) {
			setValue((v) => v + input)
		}
	})

	const masked = value.length > 0
		? value.slice(0, 3) + '·'.repeat(Math.max(0, value.length - 3))
		: ''

	return (
		<Box flexDirection="column">
			<Text>Enter API key for {chalk.bold(PROVIDER_PRESETS[providerName]?.label ?? providerName)}:</Text>
			<Text>{masked}█</Text>
			<Text dimColor>Press Enter to confirm · Esc to cancel</Text>
		</Box>
	)
}

// ─── Model picker (fetches from API) ─────────────────────────────────────────

function ModelPicker({
	providerName,
	onDone,
}: {
	providerName: ProviderName
	onDone: OnDone
}) {
	const [models, setModels] = React.useState<string[] | null>(null)
	const [error, setError] = React.useState<string | null>(null)
	const [selectedModel, setSelectedModel] = React.useState<string | null>(null)

	React.useEffect(() => {
		fetchProviderModels(providerName)
			.then((list) => {
				if (list.length === 0) {
					// No models found — fall back to default
					finishWithModel(providerName, getDefaultModelForProvider(providerName), onDone)
				} else {
					setModels(list)
				}
			})
			.catch(() => {
				setError('Failed to fetch models')
			})
	}, [providerName, onDone])

	if (error) {
		// Fall back to default model on error
		React.useEffect(() => {
			finishWithModel(providerName, getDefaultModelForProvider(providerName), onDone)
		}, [])
		return null
	}

	if (models === null) {
		return <Text>Fetching models...</Text>
	}

	if (selectedModel) {
		return <ThinkingModePicker providerName={providerName} model={selectedModel} onDone={onDone} />
	}

	const options = models.map((id) => ({
		label: id,
		value: id,
		description: '',
	}))

	return (
		<Select<string>
			options={options}
			visibleOptionCount={15}
			onChange={(modelId) => {
				setSelectedModel(modelId)
			}}
			onCancel={() => {
				onDone('Cancelled', { display: 'system' })
			}}
		/>
	)
}

// ─── Thinking mode picker ────────────────────────────────────────────────────

type ThinkingValue = 'none' | 'effort_high' | 'effort_medium' | 'effort_low' | 'think_tags'

function thinkingModeToValue(mode: ThinkingMode): ThinkingValue {
	if (mode.type === 'reasoning_effort') return `effort_${mode.level}` as ThinkingValue
	if (mode.type === 'think_tags') return 'think_tags'
	return 'none'
}

function valueToThinkingMode(value: ThinkingValue): ThinkingMode {
	if (value === 'effort_high') return { type: 'reasoning_effort', level: 'high' }
	if (value === 'effort_medium') return { type: 'reasoning_effort', level: 'medium' }
	if (value === 'effort_low') return { type: 'reasoning_effort', level: 'low' }
	if (value === 'think_tags') return { type: 'think_tags' }
	return { type: 'none' }
}

function parseThinkingArg(arg: string | undefined): ThinkingMode | undefined {
	if (!arg) return undefined
	switch (arg) {
		case 'none': return { type: 'none' }
		case 'high': return { type: 'reasoning_effort', level: 'high' }
		case 'medium': return { type: 'reasoning_effort', level: 'medium' }
		case 'low': return { type: 'reasoning_effort', level: 'low' }
		case 'think': case 'think_tags': return { type: 'think_tags' }
		default: return undefined
	}
}

const ALL_THINKING_OPTIONS: Array<{ label: string; value: ThinkingValue; description: string }> = [
	{ label: 'None', value: 'none', description: 'No thinking / reasoning' },
	{ label: 'Reasoning effort (high)', value: 'effort_high', description: 'OpenAI reasoning_effort param' },
	{ label: 'Reasoning effort (medium)', value: 'effort_medium', description: 'OpenAI reasoning_effort param' },
	{ label: 'Reasoning effort (low)', value: 'effort_low', description: 'OpenAI reasoning_effort param' },
	{ label: 'Think tags', value: 'think_tags', description: '<think>…</think> in output' },
]

function ThinkingModePicker({
	providerName,
	model,
	onDone,
}: {
	providerName: ProviderName
	model: string
	onDone: OnDone
}) {
	const inferred = inferThinkingMode(providerName, model)
	const inferredValue = thinkingModeToValue(inferred)

	const options = ALL_THINKING_OPTIONS.map((opt) =>
		opt.value === inferredValue
			? { ...opt, label: `${opt.label} (auto)` }
			: opt
	).sort((a, b) => {
		if (a.value === inferredValue) return -1
		if (b.value === inferredValue) return 1
		return 0
	})

	return (
		<Box flexDirection="column">
			<Text>Model: {chalk.bold(model)} · Select thinking mode:</Text>
			<Select<ThinkingValue>
				options={options}
				onChange={(value) => {
					finishWithModel(providerName, model, onDone, valueToThinkingMode(value))
				}}
				onCancel={() => {
					onDone('Cancelled', { display: 'system' })
				}}
			/>
		</Box>
	)
}

// ─── Provider picker → model picker flow ─────────────────────────────────────

function ProviderPicker({ onDone }: { onDone: OnDone }) {
	const [selectedProvider, setSelectedProvider] = React.useState<ProviderName | null>(null)
	const [needsKey, setNeedsKey] = React.useState<ProviderName | null>(null)

	if (needsKey) {
		return (
			<ApiKeyInput
				providerName={needsKey}
				onKey={() => {
					setNeedsKey(null)
					setSelectedProvider(needsKey)
				}}
				onCancel={() => {
					onDone('Cancelled', { display: 'system' })
				}}
			/>
		)
	}

	if (selectedProvider) {
		return <ModelPicker providerName={selectedProvider} onDone={onDone} />
	}

	return (
		<Select<ProviderValue>
			options={getProviderOptions()}
			onChange={(value) => {
				if (value === 'anthropic') {
					setOpenAICompatConfig(null)
					onDone(`Switched to ${chalk.bold('Anthropic')} (default)`)
					return
				}

				const providerName = value as ProviderName

				// For openai, also accept Codex auth (no explicit API key needed)
				if (providerName === 'openai' && readCodexAuth()) {
					setSelectedProvider(providerName)
					return
				}

				if (!resolveApiKey(providerName)) {
					// No key available — prompt for input
					setNeedsKey(providerName)
					return
				}

				// Show model picker for this provider
				setSelectedProvider(providerName)
			}}
		/>
	)
}

// ─── Direct args handling ────────────────────────────────────────────────────

function SetProviderDirect({
	args,
	onDone,
}: {
	args: string
	onDone: OnDone
}) {
	const parts = args.trim().split(/\s+/)
	const providerArg = parts[0]!.toLowerCase() as ProviderValue
	const modelArg = parts[1]

	const thinkingArg = parseThinkingArg(parts[2]?.toLowerCase())
	const [needsKey, setNeedsKey] = React.useState(false)
	const [pendingModel, setPendingModel] = React.useState<string | null>(null)

	if (pendingModel) {
		return <ThinkingModePicker providerName={providerArg as ProviderName} model={pendingModel} onDone={onDone} />
	}

	// If model specified, apply directly
	if (!needsKey && (modelArg || providerArg === 'anthropic')) {
		React.useEffect(() => {
			if (providerArg === 'anthropic' || providerArg === ('default' as any)) {
				setOpenAICompatConfig(null)
				onDone(`Switched to ${chalk.bold('Anthropic')} (default)`)
			} else {
				const name = providerArg as ProviderName
				if (!resolveApiKey(name)) {
					setNeedsKey(true)
					return
				}
				if (thinkingArg) {
					finishWithModel(name, modelArg!, onDone, thinkingArg)
				} else {
					setPendingModel(modelArg!)
				}
			}
		}, [])
		return null
	}

	// No model specified — show model picker
	const providerName = providerArg as ProviderName
	const preset = PROVIDER_PRESETS[providerName]
	if (!needsKey && !preset) {
		React.useEffect(() => {
			onDone(
				`Unknown provider '${providerArg}'. Available: anthropic, openai, openrouter, siliconflow, custom`,
				{ display: 'system' },
			)
		}, [])
		return null
	}

	if (needsKey || !hasProviderAuthentication(providerName)) {
		return (
			<ApiKeyInput
				providerName={providerName}
				onKey={() => {
					if (modelArg) {
						if (thinkingArg) {
							finishWithModel(providerName, modelArg, onDone, thinkingArg)
						} else {
							setPendingModel(modelArg)
						}
					} else {
						setNeedsKey(false)
					}
				}}
				onCancel={() => {
					onDone('Cancelled', { display: 'system' })
				}}
			/>
		)
	}

	return <ModelPicker providerName={providerName} onDone={onDone} />
}

function ShowProviderAndClose({ onDone }: { onDone: OnDone }) {
	const config = getOpenAICompatConfig()
	if (config) {
		onDone(
			`Current provider: ${chalk.bold(config.providerName)} · ${config.baseURL}\nModel: ${chalk.bold(config.model)} · Thinking: ${config.thinkingMode.type}`,
		)
	} else {
		onDone(`Current provider: ${chalk.bold('Anthropic')} (default)`)
	}
	return null
}

// ─── Entry point ─────────────────────────────────────────────────────────────

const COMMON_INFO_ARGS = ['?', 'status', 'info', 'current']
const COMMON_HELP_ARGS = ['help', '-h', '--help']

export const call: LocalJSXCommandCall = async (onDone, _context, args) => {
	args = args?.trim() || ''

	if (COMMON_INFO_ARGS.includes(args)) {
		return <ShowProviderAndClose onDone={onDone} />
	}

	if (COMMON_HELP_ARGS.includes(args)) {
			onDone(
				'Usage: /provider [openai|openrouter|siliconflow|custom|anthropic] [model] [thinking]\n' +
					'Thinking: none, high/medium/low (reasoning_effort), think (think_tags)\n' +
					'API keys are stored per-provider in ~/.claude/myclaw/openai-compat.json\n' +
					'Env var OPENAI_COMPAT_API_KEY overrides stored keys when set (except OpenAI + Codex ChatGPT login)',
				{ display: 'system' },
			)
			return
		}

	if (args) {
		return <SetProviderDirect args={args} onDone={onDone} />
	}

	return <ProviderPicker onDone={onDone} />
}

// ─── Shared logic ────────────────────────────────────────────────────────────

function finishWithModel(
	providerName: ProviderName,
	model: string,
	onDone: OnDone,
	thinkingOverride?: ThinkingMode,
): void {
	const preset = PROVIDER_PRESETS[providerName]
	if (!preset) return

	const auth = resolveProviderAuthentication(
		providerName,
		getStoredKeyForProvider(providerName),
	)
	const apiKey = auth.apiKey || ''
	const thinkingMode = thinkingOverride ?? inferThinkingMode(providerName, model)

	// When using Codex ChatGPT auth, route through Responses API
	const isCodex = providerName === 'openai' && auth.useResponsesApi
	const effectiveKey = apiKey
	const baseURL = isCodex
		? getCodexBaseURL()
		: (process.env.OPENAI_COMPAT_BASE_URL || preset.baseURL)

	const config: OpenAIProviderConfig = {
		providerName,
		baseURL,
		apiKey: effectiveKey,
		model,
		thinkingMode,
		useResponsesApi: isCodex,
	}
	setOpenAICompatConfig(config)
	if (isCodex) {
		void scheduleResponsesStartupWebSocketPrewarm(config)
	}

	const providerLabel = isCodex ? 'OpenAI (Codex)' : preset.label
	onDone(
		`Switched to ${chalk.bold(providerLabel)} · Model: ${chalk.bold(model)}` +
			(thinkingMode.type !== 'none'
				? ` · Thinking: ${thinkingMode.type}`
				: '') +
			(isCodex ? ' · Responses API' : ''),
	)
}

function getDefaultModelForProvider(name: ProviderName): string {
	switch (name) {
		case 'openai':
			// Default to Codex's flagship model when using ChatGPT auth
			return resolveProviderAuthentication(
				name,
				getStoredKeyForProvider(name),
			).useResponsesApi
				? 'gpt-5.3-codex'
				: 'gpt-4o'
		case 'openrouter':
			return 'openai/gpt-4o'
		case 'siliconflow':
			return 'deepseek-ai/DeepSeek-V3'
		default:
			return 'gpt-4o'
	}
}
