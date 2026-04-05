/**
 * OpenAI model catalog — declares per-model effort levels, defaults, and
 * context windows. Inspired by Codex CLI's models.json.
 *
 * Bundled defaults cover the Codex ChatGPT model family. Users can override
 * or extend via ~/.claude/myclaw/models.json.
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { getClaudeConfigHomeDir } from '../../../utils/envUtils.js'
import type { EffortLevel } from '../../../utils/effort.js'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface OpenAIModelInfo {
	slug: string
	displayName: string
	supportedEfforts: EffortLevel[]
	defaultEffort: EffortLevel
	contextWindow: number
}

// ─── Effort mapping (Codex xhigh ↔ myclaw max) ──────────────────────────────

type CodexEffortLevel = 'low' | 'medium' | 'high' | 'xhigh'

function codexEffortToMyclaw(level: string): EffortLevel | null {
	switch (level) {
		case 'low':
			return 'low'
		case 'medium':
			return 'medium'
		case 'high':
			return 'high'
		case 'xhigh':
			return 'max'
		default:
			return null
	}
}

export function myclawEffortToCodex(level: EffortLevel): CodexEffortLevel {
	return level === 'max' ? 'xhigh' : level
}

// ─── Bundled catalog ─────────────────────────────────────────────────────────

const BUNDLED_CATALOG: OpenAIModelInfo[] = [
	{
		slug: 'gpt-5.4',
		displayName: 'gpt-5.4',
		supportedEfforts: ['low', 'medium', 'high', 'max'],
		defaultEffort: 'medium',
		contextWindow: 272000,
	},
	{
		slug: 'gpt-5.3-codex',
		displayName: 'gpt-5.3-codex',
		supportedEfforts: ['low', 'medium', 'high', 'max'],
		defaultEffort: 'medium',
		contextWindow: 272000,
	},
	{
		slug: 'gpt-5.2-codex',
		displayName: 'gpt-5.2-codex',
		supportedEfforts: ['low', 'medium', 'high', 'max'],
		defaultEffort: 'medium',
		contextWindow: 272000,
	},
	{
		slug: 'gpt-5.2',
		displayName: 'gpt-5.2',
		supportedEfforts: ['low', 'medium', 'high', 'max'],
		defaultEffort: 'medium',
		contextWindow: 272000,
	},
	{
		slug: 'gpt-5.1-codex-max',
		displayName: 'gpt-5.1-codex-max',
		supportedEfforts: ['low', 'medium', 'high', 'max'],
		defaultEffort: 'medium',
		contextWindow: 272000,
	},
	{
		slug: 'gpt-5.1-codex-mini',
		displayName: 'gpt-5.1-codex-mini',
		supportedEfforts: ['medium', 'high'],
		defaultEffort: 'medium',
		contextWindow: 272000,
	},
	{
		slug: 'gpt-5.1-codex',
		displayName: 'gpt-5.1-codex',
		supportedEfforts: ['low', 'medium', 'high'],
		defaultEffort: 'medium',
		contextWindow: 272000,
	},
	{
		slug: 'gpt-5.1',
		displayName: 'gpt-5.1',
		supportedEfforts: ['low', 'medium', 'high'],
		defaultEffort: 'medium',
		contextWindow: 272000,
	},
	{
		slug: 'gpt-5-codex-mini',
		displayName: 'gpt-5-codex-mini',
		supportedEfforts: ['medium', 'high'],
		defaultEffort: 'medium',
		contextWindow: 272000,
	},
	{
		slug: 'gpt-5-codex',
		displayName: 'gpt-5-codex',
		supportedEfforts: ['low', 'medium', 'high'],
		defaultEffort: 'medium',
		contextWindow: 272000,
	},
	{
		slug: 'gpt-5',
		displayName: 'gpt-5',
		supportedEfforts: ['low', 'medium', 'high'],
		defaultEffort: 'medium',
		contextWindow: 272000,
	},
	// o-series reasoning models
	{
		slug: 'o4-mini',
		displayName: 'o4-mini',
		supportedEfforts: ['low', 'medium', 'high'],
		defaultEffort: 'medium',
		contextWindow: 200000,
	},
	{
		slug: 'o3',
		displayName: 'o3',
		supportedEfforts: ['low', 'medium', 'high'],
		defaultEffort: 'medium',
		contextWindow: 200000,
	},
	{
		slug: 'o3-mini',
		displayName: 'o3-mini',
		supportedEfforts: ['low', 'medium', 'high'],
		defaultEffort: 'medium',
		contextWindow: 200000,
	},
	{
		slug: 'o1',
		displayName: 'o1',
		supportedEfforts: ['low', 'medium', 'high'],
		defaultEffort: 'medium',
		contextWindow: 200000,
	},
	{
		slug: 'o1-mini',
		displayName: 'o1-mini',
		supportedEfforts: ['low', 'medium', 'high'],
		defaultEffort: 'medium',
		contextWindow: 128000,
	},
]

// ─── User overrides ──────────────────────────────────────────────────────────

interface UserModelEntry {
	slug: string
	display_name?: string
	displayName?: string
	supported_reasoning_levels?: Array<{ effort: string }>
	supportedEfforts?: string[]
	default_reasoning_level?: string
	defaultEffort?: string
	context_window?: number
	contextWindow?: number
}

function loadUserOverrides(): OpenAIModelInfo[] {
	try {
		const path = join(getClaudeConfigHomeDir(), 'myclaw', 'models.json')
		const raw = readFileSync(path, 'utf-8')
		const data = JSON.parse(raw) as
			| { models?: UserModelEntry[] }
			| UserModelEntry[]
		const entries = Array.isArray(data) ? data : (data.models ?? [])

		return entries
			.map((entry): OpenAIModelInfo | null => {
				const slug = entry.slug
				if (!slug) return null

				let efforts: EffortLevel[]
				if (entry.supported_reasoning_levels) {
					efforts = entry.supported_reasoning_levels
						.map((l) => codexEffortToMyclaw(l.effort))
						.filter((e): e is EffortLevel => e !== null)
				} else if (entry.supportedEfforts) {
					efforts = entry.supportedEfforts
						.map((e) => codexEffortToMyclaw(e))
						.filter((e): e is EffortLevel => e !== null)
				} else {
					efforts = ['low', 'medium', 'high']
				}

				const defaultRaw =
					entry.default_reasoning_level ?? entry.defaultEffort
				const defaultEffort = defaultRaw
					? (codexEffortToMyclaw(defaultRaw) ?? 'medium')
					: 'medium'

				return {
					slug,
					displayName:
						entry.display_name ?? entry.displayName ?? slug,
					supportedEfforts: efforts.length > 0 ? efforts : ['medium', 'high'],
					defaultEffort,
					contextWindow:
						entry.context_window ?? entry.contextWindow ?? 128000,
				}
			})
			.filter((e): e is OpenAIModelInfo => e !== null)
	} catch {
		return []
	}
}

// ─── Merged catalog (user overrides take precedence) ─────────────────────────

let _catalog: Map<string, OpenAIModelInfo> | null = null

function getCatalog(): Map<string, OpenAIModelInfo> {
	if (_catalog) return _catalog
	_catalog = new Map<string, OpenAIModelInfo>()

	// Bundled entries first
	for (const entry of BUNDLED_CATALOG) {
		_catalog.set(entry.slug.toLowerCase(), entry)
	}

	// User overrides on top
	for (const entry of loadUserOverrides()) {
		_catalog.set(entry.slug.toLowerCase(), entry)
	}

	return _catalog
}

/**
 * Look up model info using longest-prefix matching.
 * e.g. "gpt-5.3-codex-20260401" matches "gpt-5.3-codex".
 */
export function getOpenAIModelInfo(
	modelSlug: string,
): OpenAIModelInfo | null {
	const catalog = getCatalog()
	const key = modelSlug.toLowerCase()

	// Exact match first
	const exact = catalog.get(key)
	if (exact) return exact

	// Longest-prefix match: find the catalog entry whose slug is the longest
	// prefix of the input model slug.
	let bestMatch: OpenAIModelInfo | null = null
	let bestLen = 0
	for (const [slug, info] of catalog) {
		if (key.startsWith(slug) && slug.length > bestLen) {
			bestMatch = info
			bestLen = slug.length
		}
	}

	return bestMatch
}

/** Reset catalog cache (for testing). */
export function resetModelCatalogForTests(): void {
	_catalog = null
}
