import { afterEach, expect, test } from 'bun:test'
import { OpenAICompatClient } from '../OpenAICompatClient.js'
import { resetResponsesClientStateForTests } from '../responsesClient.js'
import { setResponsesWebSocketFactoryForTests } from '../responsesWebSocketClient.js'
import { resetStateForTests } from '../../../../bootstrap/state.js'

afterEach(() => {
	resetStateForTests()
	resetResponsesClientStateForTests()
	setResponsesWebSocketFactoryForTests(null)
})

function createMockWebSocketConnection(messages: Array<Record<string, any>>) {
	const queue = messages.map(message => JSON.stringify(message))

	return {
		responseHeaders: new Headers(),
		async send(_payload: string) {},
		async *messages() {
			while (queue.length > 0) {
				yield queue.shift()!
			}
		},
		close() {},
		isClosed() {
			return false
		},
	}
}

test('returns a BetaMessage for non-streaming Responses API requests', async () => {
	setResponsesWebSocketFactoryForTests(async () =>
		createMockWebSocketConnection([
			{ type: 'response.created', response: { id: 'resp_nonstream_1' } },
			{
				type: 'response.output_text.delta',
				response: { id: 'resp_nonstream_1' },
				delta: 'hello from responses',
			},
			{
				type: 'response.completed',
				response: {
					id: 'resp_nonstream_1',
					usage: { input_tokens: 3, output_tokens: 2 },
				},
			},
		]),
	)

	const client = new OpenAICompatClient({
		providerName: 'openai',
		baseURL: 'https://chatgpt.com/backend-api/codex',
		apiKey: 'codex-access-token',
		model: 'gpt-5.3-codex',
		thinkingMode: { type: 'none' },
		useResponsesApi: true,
	})

	const result = await client.beta.messages.create({
		model: 'claude-sonnet-4-20250514',
		max_tokens: 256,
		messages: [{ role: 'user', content: 'hello' }],
		stream: false,
	} as any)

	expect(result.type).toBe('message')
	expect(result.content).toEqual([
		{
			type: 'text',
			text: 'hello from responses',
		},
	])
	expect(result.usage).toEqual({
		input_tokens: 3,
		output_tokens: 2,
		cache_creation_input_tokens: 0,
		cache_read_input_tokens: 0,
	})
})
