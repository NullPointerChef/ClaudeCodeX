import { afterEach, expect, test } from 'bun:test'
import { randomUUID } from 'crypto'
import {
	normalizeMessagesForAPI,
	stripCallerFieldFromAssistantMessage,
} from '../messages.js'

const ORIGINAL_DISABLE_EXPERIMENTAL_BETAS =
	process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS

afterEach(() => {
	if (ORIGINAL_DISABLE_EXPERIMENTAL_BETAS === undefined) {
		delete process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS
	} else {
		process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS =
			ORIGINAL_DISABLE_EXPERIMENTAL_BETAS
	}
})

test('stripCallerFieldFromAssistantMessage preserves Responses item ids', () => {
	const message = {
		type: 'assistant' as const,
		uuid: randomUUID(),
		message: {
			role: 'assistant',
			content: [
				{
					type: 'tool_use' as const,
					id: 'call_123',
					response_item_id: 'fc_123',
					name: 'Skill',
					input: { command: 'superpowers:using-superpowers' },
					caller: { type: 'server' },
				},
			],
		},
	}

	const stripped = stripCallerFieldFromAssistantMessage(message as any)
	const block = (stripped.message.content as Array<Record<string, unknown>>)[0]

	expect(block).toEqual({
		type: 'tool_use',
		id: 'call_123',
		response_item_id: 'fc_123',
		name: 'Skill',
		input: { command: 'superpowers:using-superpowers' },
	})
})

test('normalizeMessagesForAPI preserves Responses item ids when tool search fields are stripped', () => {
	process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = 'true'

	const normalized = normalizeMessagesForAPI(
		[
			{
				type: 'assistant',
				uuid: randomUUID(),
				message: {
					role: 'assistant',
					content: [
						{
							type: 'tool_use',
							id: 'call_123',
							response_item_id: 'fc_123',
							name: 'Skill',
							input: { command: 'superpowers:using-superpowers' },
							caller: { type: 'server' },
						},
					],
				},
			},
		] as any,
		[],
	)

	const block = (
		normalized[0]?.message.content as Array<Record<string, unknown>>
	)[0]

	expect(block).toEqual({
		type: 'tool_use',
		id: 'call_123',
		response_item_id: 'fc_123',
		name: 'Skill',
		input: { command: 'superpowers:using-superpowers' },
	})
})
