import type { Command } from '../../commands.js'

export default {
	type: 'local-jsx',
	name: 'provider',
	description: 'Switch AI provider (OpenAI-compatible endpoints)',
	isEnabled: () => true,
	isHidden: false,
	argumentHint: '[openai|openrouter|siliconflow|custom|anthropic] [model]',
	load: () => import('./provider.js'),
} satisfies Command
