import { afterEach, expect, mock, test } from 'bun:test'
import { getSessionId, resetStateForTests } from '../../../../bootstrap/state.js'
import {
	createResponsesApiStream,
	resetResponsesClientStateForTests,
	scheduleResponsesStartupWebSocketPrewarm,
} from '../responsesClient.js'
import { setResponsesTelemetryHooksForTests } from '../responsesTelemetry.js'
import { setResponsesWebSocketFactoryForTests } from '../responsesWebSocketClient.js'

const ORIGINAL_FETCH = globalThis.fetch

afterEach(() => {
	globalThis.fetch = ORIGINAL_FETCH
	resetStateForTests()
	resetResponsesClientStateForTests()
	setResponsesTelemetryHooksForTests(null)
	setResponsesWebSocketFactoryForTests(null)
})

function createMockReusableWebSocketConnection(
	requestPlans: Array<{
		messages: Array<Record<string, any>>
		closeAfterRequest?: boolean
	}>,
	responseHeaders: Record<string, string> = {},
) {
	const payloads: Array<Record<string, any>> = []
	const queue: string[] = []
	let queueWaiter: (() => void) | null = null
	let closed = false

	const wakeQueue = () => {
		queueWaiter?.()
		queueWaiter = null
	}

	return {
		payloads,
		connection: {
			responseHeaders: new Headers(responseHeaders),
			async send(payload: string) {
				payloads.push(JSON.parse(payload) as Record<string, any>)
				const plan = requestPlans.shift()
				if (!plan) {
					throw new Error('unexpected websocket request')
				}

				for (const message of plan.messages) {
					queue.push(JSON.stringify(message))
				}
				if (plan.closeAfterRequest) {
					closed = true
				}
				wakeQueue()
			},
			async *messages() {
				while (!closed || queue.length > 0) {
					if (queue.length === 0) {
						await new Promise<void>(resolve => {
							queueWaiter = resolve
						})
						continue
					}

					const message = queue.shift()
					if (message !== undefined) {
						yield message
					}
				}
			},
			close() {
				closed = true
				wakeQueue()
			},
			isClosed() {
				return closed
			},
		},
	}
}

test('sends Codex-style session headers and preserves caller headers', async () => {
	let requestHeaders: Headers | undefined

	globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
		requestHeaders = new Headers(init?.headers)
		return new Response('', {
			status: 200,
			headers: {
				'Content-Type': 'text/event-stream',
			},
		})
	}) as typeof fetch

	await createResponsesApiStream(
		{
			model: 'claude-sonnet-4-20250514',
			max_tokens: 256,
			messages: [{ role: 'user', content: 'hello' }],
			stream: true,
		} as any,
		{
			providerName: 'openai',
			baseURL: 'https://chatgpt.com/backend-api/codex',
			apiKey: 'codex-access-token',
			model: 'gpt-5.3-codex',
			thinkingMode: { type: 'none' },
			useResponsesApi: true,
		},
		{
			headers: {
				'x-test-header': 'preserved',
			},
		},
	)

	expect(requestHeaders?.get('x-client-request-id')).toBe(getSessionId())
	expect(requestHeaders?.get('session_id')).toBe(getSessionId())
	expect(requestHeaders?.get('x-test-header')).toBe('preserved')
})

test('routes function_call argument deltas by item_id for parallel tool calls', async () => {
	const sse = [
		'data: {"type":"response.created","response":{"id":"resp_1"}}',
		'',
		'data: {"type":"response.output_item.added","item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"ToolA"}}',
		'',
		'data: {"type":"response.output_item.added","item":{"type":"function_call","id":"fc_2","call_id":"call_2","name":"ToolB"}}',
		'',
		'data: {"type":"response.function_call_arguments.delta","item_id":"fc_1","output_index":0,"delta":"{\\"a\\":"}',
		'',
		'data: {"type":"response.function_call_arguments.delta","item_id":"fc_2","output_index":1,"delta":"{\\"b\\":"}',
		'',
		'data: {"type":"response.function_call_arguments.delta","item_id":"fc_1","output_index":0,"delta":"1}"}',
		'',
		'data: {"type":"response.function_call_arguments.delta","item_id":"fc_2","output_index":1,"delta":"2}"}',
		'',
		'data: {"type":"response.output_item.done","item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"ToolA","arguments":"{\\"a\\":1}"}}',
		'',
		'data: {"type":"response.output_item.done","item":{"type":"function_call","id":"fc_2","call_id":"call_2","name":"ToolB","arguments":"{\\"b\\":2}"}}',
		'',
		'data: {"type":"response.completed","response":{"id":"resp_1","usage":{"input_tokens":3,"output_tokens":2}}}',
		'',
	].join('\n') + '\n'

	globalThis.fetch = mock(async () => {
		return new Response(sse, {
			status: 200,
			headers: {
				'Content-Type': 'text/event-stream',
			},
		})
	}) as typeof fetch

	const stream = await createResponsesApiStream(
		{
			model: 'claude-sonnet-4-20250514',
			max_tokens: 256,
			messages: [{ role: 'user', content: 'hello' }],
			stream: true,
		} as any,
		{
			providerName: 'openai',
			baseURL: 'https://chatgpt.com/backend-api/codex',
			apiKey: 'codex-access-token',
			model: 'gpt-5.3-codex',
			thinkingMode: { type: 'none' },
			useResponsesApi: true,
		},
	)

	const events: Array<Record<string, any>> = []
	for await (const event of stream as AsyncIterable<Record<string, any>>) {
		events.push(event)
	}

	const toolStarts = events.filter(
		event =>
			event.type === 'content_block_start' &&
			event.content_block?.type === 'tool_use',
	)
	const toolABlockIndex = toolStarts.find(
		event => event.content_block?.response_item_id === 'fc_1',
	)?.index
	const toolBBlockIndex = toolStarts.find(
		event => event.content_block?.response_item_id === 'fc_2',
	)?.index

	const toolADeltas = events
		.filter(
			event =>
				event.type === 'content_block_delta' &&
				event.index === toolABlockIndex &&
				event.delta?.type === 'input_json_delta' &&
				event.delta.partial_json,
		)
		.map(event => event.delta.partial_json)
	const toolBDeltas = events
		.filter(
			event =>
				event.type === 'content_block_delta' &&
				event.index === toolBBlockIndex &&
				event.delta?.type === 'input_json_delta' &&
				event.delta.partial_json,
		)
		.map(event => event.delta.partial_json)

	expect(toolADeltas).toEqual(['{"a":', '1}'])
	expect(toolBDeltas).toEqual(['{"b":', '2}'])
})

test('does not send previous_response_id to the Codex ChatGPT Responses endpoint', async () => {
	const requestBodies: Array<Record<string, any>> = []
	let callCount = 0

	globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
		requestBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, any>)
		callCount += 1

		const sse =
			callCount === 1
				? [
						'data: {"type":"response.created","response":{"id":"resp_1"}}',
						'',
						'data: {"type":"response.output_text.delta","response":{"id":"resp_1"},"delta":"hi"}',
						'',
						'data: {"type":"response.completed","response":{"id":"resp_1","usage":{"input_tokens":3,"output_tokens":1}}}',
						'',
					].join('\n') + '\n'
				: [
						'data: {"type":"response.created","response":{"id":"resp_2"}}',
						'',
						'data: {"type":"response.completed","response":{"id":"resp_2","usage":{"input_tokens":2,"output_tokens":1}}}',
						'',
					].join('\n') + '\n'

		return new Response(sse, {
			status: 200,
			headers: {
				'Content-Type': 'text/event-stream',
			},
		})
	}) as typeof fetch

	const config = {
		providerName: 'openai' as const,
		baseURL: 'https://chatgpt.com/backend-api/codex',
		apiKey: 'codex-access-token',
		model: 'gpt-5.3-codex',
		thinkingMode: { type: 'none' } as const,
		useResponsesApi: true,
	}

	const firstStream = await createResponsesApiStream(
		{
			model: 'claude-sonnet-4-20250514',
			max_tokens: 256,
			messages: [{ role: 'user', content: 'hello' }],
			stream: true,
		} as any,
		config,
	)

	for await (const _event of firstStream as AsyncIterable<Record<string, any>>) {
		// Drain the stream so the completed response is captured for continuation.
	}

	const secondStream = await createResponsesApiStream(
		{
			model: 'claude-sonnet-4-20250514',
			max_tokens: 256,
			messages: [
				{ role: 'user', content: 'hello' },
				{
					role: 'assistant',
					content: [{ type: 'text', text: 'hi' }],
				},
				{ role: 'user', content: 'how are you?' },
			],
			stream: true,
		} as any,
		config,
	)

	for await (const _event of secondStream as AsyncIterable<Record<string, any>>) {
		// Drain the second stream to keep the mock response lifecycle realistic.
	}

	expect(requestBodies[1]?.previous_response_id).toBeUndefined()
	expect(requestBodies[1]?.input).toEqual([
		{
			role: 'user',
			content: [{ type: 'input_text', text: 'hello' }],
		},
		{
			role: 'assistant',
			content: [{ type: 'output_text', text: 'hi' }],
		},
		{
			role: 'user',
			content: [{ type: 'input_text', text: 'how are you?' }],
		},
	])
})

test('reconnects within a tool turn and reuses the same websocket across the next turn', async () => {
	const websocketRequests: Array<{
		url: string
		headers: Headers
	}> = []
	const firstConnection = createMockReusableWebSocketConnection(
		[
			{
				messages: [
					{ type: 'response.created', response: { id: 'resp_1' } },
					{
						type: 'response.output_item.added',
						item: {
							type: 'function_call',
							id: 'fc_1',
							call_id: 'call_1',
							name: 'Skill',
						},
					},
					{
						type: 'response.output_item.done',
						item: {
							type: 'function_call',
							id: 'fc_1',
							call_id: 'call_1',
							name: 'Skill',
							arguments: '{"command":"echo hi"}',
						},
					},
					{
						type: 'response.completed',
						response: {
							id: 'resp_1',
							usage: { input_tokens: 3, output_tokens: 1 },
						},
					},
				],
				closeAfterRequest: true,
			},
		],
		{ 'x-codex-turn-state': 'ts-1' },
	)
	const secondConnection = createMockReusableWebSocketConnection([
		{
			messages: [
				{ type: 'response.created', response: { id: 'resp_2' } },
				{
					type: 'response.output_text.delta',
					response: { id: 'resp_2' },
					delta: 'done',
				},
				{
					type: 'response.completed',
					response: {
						id: 'resp_2',
						usage: { input_tokens: 2, output_tokens: 1 },
					},
				},
			],
		},
		{
			messages: [
				{ type: 'response.created', response: { id: 'resp_3' } },
				{
					type: 'response.output_text.delta',
					response: { id: 'resp_3' },
					delta: 'next turn',
				},
				{
					type: 'response.completed',
					response: {
						id: 'resp_3',
						usage: { input_tokens: 2, output_tokens: 1 },
					},
				},
			],
		},
	])
	const plannedConnections = [firstConnection, secondConnection]

	globalThis.fetch = mock(async () => {
		throw new Error('fetch should not be used when websocket transport succeeds')
	}) as typeof fetch

	setResponsesWebSocketFactoryForTests(async ({ url, headers }) => {
		const planned = plannedConnections.shift()
		if (!planned) {
			throw new Error('unexpected websocket connection')
		}

		websocketRequests.push({
			url,
			headers: new Headers(headers),
		})

		return planned.connection
	})

	const config = {
		providerName: 'openai' as const,
		baseURL: 'https://chatgpt.com/backend-api/codex',
		apiKey: 'codex-access-token',
		model: 'gpt-5.3-codex',
		thinkingMode: { type: 'none' } as const,
		useResponsesApi: true,
	}

	const firstStream = await createResponsesApiStream(
		{
			model: 'claude-sonnet-4-20250514',
			max_tokens: 256,
			messages: [{ role: 'user', content: 'run the skill' }],
			stream: true,
		} as any,
		config,
	)
	for await (const _event of firstStream as AsyncIterable<Record<string, any>>) {
	}

	const secondStream = await createResponsesApiStream(
		{
			model: 'claude-sonnet-4-20250514',
			max_tokens: 256,
			messages: [
				{ role: 'user', content: 'run the skill' },
				{
					role: 'assistant',
					content: [
						{
							type: 'tool_use',
							id: 'call_1',
							response_item_id: 'fc_1',
							name: 'Skill',
							input: { command: 'echo hi' },
						},
					],
				},
				{
					role: 'user',
					content: [
						{
							type: 'tool_result',
							tool_use_id: 'call_1',
							content: 'ok',
						},
					],
				},
			],
			stream: true,
		} as any,
		config,
	)
	for await (const _event of secondStream as AsyncIterable<Record<string, any>>) {
	}

	const thirdStream = await createResponsesApiStream(
		{
			model: 'claude-sonnet-4-20250514',
			max_tokens: 256,
			messages: [
				{ role: 'user', content: 'run the skill' },
				{
					role: 'assistant',
					content: [
						{
							type: 'tool_use',
							id: 'call_1',
							response_item_id: 'fc_1',
							name: 'Skill',
							input: { command: 'echo hi' },
						},
					],
				},
				{
					role: 'user',
					content: [
						{
							type: 'tool_result',
							tool_use_id: 'call_1',
							content: 'ok',
						},
					],
				},
				{
					role: 'assistant',
					content: [{ type: 'text', text: 'done' }],
				},
				{ role: 'user', content: 'next turn' },
			],
			stream: true,
		} as any,
		config,
	)
	for await (const _event of thirdStream as AsyncIterable<Record<string, any>>) {
	}

	expect(websocketRequests).toHaveLength(2)
	expect(websocketRequests[0]?.url).toBe('wss://chatgpt.com/backend-api/codex/responses')
	expect(websocketRequests[0]?.headers.get('openai-beta')).toBe(
		'responses_websockets=2026-02-06',
	)
	expect(websocketRequests[0]?.headers.get('x-client-request-id')).toBe(getSessionId())
	expect(websocketRequests[0]?.headers.get('session_id')).toBe(getSessionId())
	expect(websocketRequests[0]?.headers.get('x-codex-turn-state')).toBeNull()
	expect(firstConnection.payloads[0]?.type).toBe('response.create')

	expect(websocketRequests[1]?.headers.get('x-codex-turn-state')).toBe('ts-1')
	expect(secondConnection.payloads[0]?.previous_response_id).toBe('resp_1')
	expect(secondConnection.payloads[0]?.input).toEqual([
		{
			type: 'function_call_output',
			call_id: 'call_1',
			output: 'ok',
		},
	])

	expect(secondConnection.payloads[1]?.previous_response_id).toBeUndefined()
})

test('falls back to REST when the Codex websocket transport fails before streaming', async () => {
	let fetchCalls = 0
	setResponsesWebSocketFactoryForTests(async () => {
		throw new Error('websocket unavailable')
	})

	globalThis.fetch = mock(async () => {
		fetchCalls += 1
		const sse = [
			'data: {"type":"response.created","response":{"id":"resp_rest"}}',
			'',
			'data: {"type":"response.output_text.delta","response":{"id":"resp_rest"},"delta":"fallback"}',
			'',
			'data: {"type":"response.completed","response":{"id":"resp_rest","usage":{"input_tokens":2,"output_tokens":1}}}',
			'',
		].join('\n') + '\n'

		return new Response(sse, {
			status: 200,
			headers: {
				'Content-Type': 'text/event-stream',
			},
		})
	}) as typeof fetch

	const stream = await createResponsesApiStream(
		{
			model: 'claude-sonnet-4-20250514',
			max_tokens: 256,
			messages: [{ role: 'user', content: 'hello' }],
			stream: true,
		} as any,
		{
			providerName: 'openai',
			baseURL: 'https://chatgpt.com/backend-api/codex',
			apiKey: 'codex-access-token',
			model: 'gpt-5.3-codex',
			thinkingMode: { type: 'none' },
			useResponsesApi: true,
		},
	)

	const events: Array<Record<string, any>> = []
	for await (const event of stream as AsyncIterable<Record<string, any>>) {
		events.push(event)
	}

	expect(fetchCalls).toBe(1)
	expect(events.some(event => event.type === 'message_start')).toBe(true)
	expect(
		events.some(
			event =>
				event.type === 'content_block_delta' &&
				event.delta?.type === 'text_delta' &&
				event.delta?.text === 'fallback',
		),
	).toBe(true)
})

test('surfaces wrapped websocket error events instead of hanging the request', async () => {
	const connection = createMockReusableWebSocketConnection([
		{
			messages: [
				{
					type: 'error',
					status: 400,
					error: {
						type: 'invalid_request_error',
						message: 'synthetic websocket invalid request',
					},
					headers: {
						'x-request-id': 'req_ws_error_1',
					},
				},
			],
		},
	])

	setResponsesWebSocketFactoryForTests(async () => connection.connection)

	const config = {
		providerName: 'openai' as const,
		baseURL: 'https://chatgpt.com/backend-api/codex',
		apiKey: 'codex-access-token',
		model: 'gpt-5.3-codex',
		thinkingMode: { type: 'none' } as const,
		useResponsesApi: true,
	}

	const abortController = new AbortController()
	const stream = await createResponsesApiStream(
		{
			model: 'claude-sonnet-4-20250514',
			max_tokens: 256,
			messages: [{ role: 'user', content: 'hello' }],
			stream: true,
		} as any,
		config,
		{
			signal: abortController.signal,
		},
	)

	const drainPromise = (async () => {
		try {
			for await (const _event of stream as AsyncIterable<Record<string, any>>) {
			}
			return 'resolved'
		} catch (error) {
			return error instanceof Error ? error.message : String(error)
		}
	})()

	let timeoutId: ReturnType<typeof setTimeout> | undefined
	const outcome = await Promise.race([
		drainPromise,
		new Promise<string>(resolve => {
			timeoutId = setTimeout(() => {
				abortController.abort()
				resolve('timed_out')
			}, 50)
		}),
	])

	if (timeoutId !== undefined) {
		clearTimeout(timeoutId)
	}

	expect(outcome).toContain('Responses API error 400')
	expect(outcome).toContain('synthetic websocket invalid request')
})

test('reopens the websocket after a terminal websocket error and resets previous_response_id', async () => {
	const websocketRequests: Array<Headers> = []
	const firstConnection = createMockReusableWebSocketConnection([
		{
			messages: [
				{ type: 'response.created', response: { id: 'resp_1' } },
				{
					type: 'response.output_item.added',
					item: {
						type: 'function_call',
						id: 'fc_1',
						call_id: 'call_1',
						name: 'Skill',
					},
				},
				{
					type: 'response.output_item.done',
					item: {
						type: 'function_call',
						id: 'fc_1',
						call_id: 'call_1',
						name: 'Skill',
						arguments: '{"command":"echo hi"}',
					},
				},
				{
					type: 'response.completed',
					response: {
						id: 'resp_1',
						usage: { input_tokens: 2, output_tokens: 1 },
					},
				},
			],
		},
		{
			messages: [
				{
					type: 'response.failed',
					response: {
						error: {
							message: 'synthetic websocket failure',
						},
					},
				},
			],
		},
	])
	const secondConnection = createMockReusableWebSocketConnection([
		{
			messages: [
				{ type: 'response.created', response: { id: 'resp_3' } },
				{
					type: 'response.output_text.delta',
					response: { id: 'resp_3' },
					delta: 'recovered',
				},
				{
					type: 'response.completed',
					response: {
						id: 'resp_3',
						usage: { input_tokens: 3, output_tokens: 1 },
					},
				},
			],
		},
	])
	const plannedConnections = [firstConnection, secondConnection]

	setResponsesWebSocketFactoryForTests(async ({ headers }) => {
		const planned = plannedConnections.shift()
		if (!planned) {
			throw new Error('unexpected websocket connection')
		}

		websocketRequests.push(new Headers(headers))
		return planned.connection
	})

	const config = {
		providerName: 'openai' as const,
		baseURL: 'https://chatgpt.com/backend-api/codex',
		apiKey: 'codex-access-token',
		model: 'gpt-5.3-codex',
		thinkingMode: { type: 'none' } as const,
		useResponsesApi: true,
	}

	const firstStream = await createResponsesApiStream(
		{
			model: 'claude-sonnet-4-20250514',
			max_tokens: 256,
			messages: [{ role: 'user', content: 'run the skill' }],
			stream: true,
		} as any,
		config,
	)
	for await (const _event of firstStream as AsyncIterable<Record<string, any>>) {
	}

	const secondStream = await createResponsesApiStream(
		{
			model: 'claude-sonnet-4-20250514',
			max_tokens: 256,
			messages: [
				{ role: 'user', content: 'run the skill' },
				{
					role: 'assistant',
					content: [
						{
							type: 'tool_use',
							id: 'call_1',
							response_item_id: 'fc_1',
							name: 'Skill',
							input: { command: 'echo hi' },
						},
					],
				},
				{
					role: 'user',
					content: [
						{
							type: 'tool_result',
							tool_use_id: 'call_1',
							content: 'ok',
						},
					],
				},
			],
			stream: true,
		} as any,
		config,
	)

	let secondError = ''
	try {
		for await (const _event of secondStream as AsyncIterable<Record<string, any>>) {
		}
	} catch (error) {
		secondError = error instanceof Error ? error.message : String(error)
	}

	const thirdStream = await createResponsesApiStream(
		{
			model: 'claude-sonnet-4-20250514',
			max_tokens: 256,
			messages: [
				{ role: 'user', content: 'run the skill' },
				{
					role: 'assistant',
					content: [
						{
							type: 'tool_use',
							id: 'call_1',
							response_item_id: 'fc_1',
							name: 'Skill',
							input: { command: 'echo hi' },
						},
					],
				},
				{
					role: 'user',
					content: [
						{
							type: 'tool_result',
							tool_use_id: 'call_1',
							content: 'ok',
						},
					],
				},
			],
			stream: true,
		} as any,
		config,
	)
	for await (const _event of thirdStream as AsyncIterable<Record<string, any>>) {
	}

	expect(secondError).toContain('synthetic websocket failure')
	expect(websocketRequests).toHaveLength(2)
	expect(firstConnection.payloads[1]?.previous_response_id).toBe('resp_1')
	expect(secondConnection.payloads[0]?.previous_response_id).toBeUndefined()
	expect(secondConnection.payloads[0]?.input).toEqual([
		{
			role: 'user',
			content: [{ type: 'input_text', text: 'run the skill' }],
		},
		{
			type: 'function_call',
			id: 'fc_1',
			call_id: 'call_1',
			name: 'Skill',
			arguments: '{"command":"echo hi"}',
		},
		{
			type: 'function_call_output',
			call_id: 'call_1',
			output: 'ok',
		},
	])
})

test('startup prewarm sends generate=false and reuses the websocket for a matching first request', async () => {
	let websocketConnections = 0
	const connection = createMockReusableWebSocketConnection([
		{
			messages: [
				{ type: 'response.created', response: { id: 'warm-1' } },
				{
					type: 'response.completed',
					response: {
						id: 'warm-1',
						usage: { input_tokens: 0, output_tokens: 0 },
					},
				},
			],
		},
		{
			messages: [
				{ type: 'response.created', response: { id: 'resp-1' } },
				{
					type: 'response.output_text.delta',
					response: { id: 'resp-1' },
					delta: 'hello',
				},
				{
					type: 'response.completed',
					response: {
						id: 'resp-1',
						usage: { input_tokens: 2, output_tokens: 1 },
					},
				},
			],
		},
	])

	globalThis.fetch = mock(async () => {
		throw new Error('fetch should not be used when websocket transport succeeds')
	}) as typeof fetch

	setResponsesWebSocketFactoryForTests(async () => {
		websocketConnections += 1
		return connection.connection
	})

	const config = {
		providerName: 'openai' as const,
		baseURL: 'https://chatgpt.com/backend-api/codex',
		apiKey: 'codex-access-token',
		model: 'gpt-5.3-codex',
		thinkingMode: { type: 'none' } as const,
		useResponsesApi: true,
	}

	await scheduleResponsesStartupWebSocketPrewarm(config)

	const stream = await createResponsesApiStream(
		{
			model: 'claude-sonnet-4-20250514',
			max_tokens: 256,
			messages: [{ role: 'user', content: 'hello' }],
			stream: true,
		} as any,
		config,
	)

	for await (const _event of stream as AsyncIterable<Record<string, any>>) {
	}

	expect(websocketConnections).toBe(1)
	expect(connection.payloads).toHaveLength(2)
	expect(connection.payloads[0]).toMatchObject({
		type: 'response.create',
		generate: false,
		input: [],
		tools: [],
	})
	expect(connection.payloads[1]?.previous_response_id).toBe('warm-1')
	expect(connection.payloads[1]?.input).toEqual([
		{
			role: 'user',
			content: [{ type: 'input_text', text: 'hello' }],
		},
	])
})

test('startup prewarm reuses the websocket without forcing previous_response_id when request fields change', async () => {
	let websocketConnections = 0
	const connection = createMockReusableWebSocketConnection([
		{
			messages: [
				{ type: 'response.created', response: { id: 'warm-1' } },
				{
					type: 'response.completed',
					response: {
						id: 'warm-1',
						usage: { input_tokens: 0, output_tokens: 0 },
					},
				},
			],
		},
		{
			messages: [
				{ type: 'response.created', response: { id: 'resp-1' } },
				{
					type: 'response.output_text.delta',
					response: { id: 'resp-1' },
					delta: 'tool-ready',
				},
				{
					type: 'response.completed',
					response: {
						id: 'resp-1',
						usage: { input_tokens: 3, output_tokens: 1 },
					},
				},
			],
		},
	])

	globalThis.fetch = mock(async () => {
		throw new Error('fetch should not be used when websocket transport succeeds')
	}) as typeof fetch

	setResponsesWebSocketFactoryForTests(async () => {
		websocketConnections += 1
		return connection.connection
	})

	const config = {
		providerName: 'openai' as const,
		baseURL: 'https://chatgpt.com/backend-api/codex',
		apiKey: 'codex-access-token',
		model: 'gpt-5.3-codex',
		thinkingMode: { type: 'none' } as const,
		useResponsesApi: true,
	}

	await scheduleResponsesStartupWebSocketPrewarm(config)

	const stream = await createResponsesApiStream(
		{
			model: 'claude-sonnet-4-20250514',
			max_tokens: 256,
			messages: [{ role: 'user', content: 'hello' }],
			tools: [
				{
					name: 'Skill',
					description: 'Run a skill',
					input_schema: {
						type: 'object',
						properties: {
							command: { type: 'string' },
						},
					},
				},
			],
			stream: true,
		} as any,
		config,
	)

	for await (const _event of stream as AsyncIterable<Record<string, any>>) {
	}

	expect(websocketConnections).toBe(1)
	expect(connection.payloads).toHaveLength(2)
	expect(connection.payloads[0]?.generate).toBe(false)
	expect(connection.payloads[1]?.previous_response_id).toBeUndefined()
	expect(connection.payloads[1]?.tools).toEqual([
		{
			type: 'function',
			name: 'Skill',
			description: 'Run a skill',
			parameters: {
				type: 'object',
				properties: {
					command: { type: 'string' },
				},
			},
		},
	])
})

test('startup prewarm is cancelled if it does not finish before the first request needs the websocket', async () => {
	const prewarmPayloads: Array<Record<string, any>> = []
	let prewarmClosed = false
	let websocketConnections = 0
	const realtimeConnection = createMockReusableWebSocketConnection([
		{
			messages: [
				{ type: 'response.created', response: { id: 'resp-1' } },
				{
					type: 'response.output_text.delta',
					response: { id: 'resp-1' },
					delta: 'hello',
				},
				{
					type: 'response.completed',
					response: {
						id: 'resp-1',
						usage: { input_tokens: 2, output_tokens: 1 },
					},
				},
			],
		},
	])
	const pendingConnection = {
		responseHeaders: new Headers(),
		async send(payload: string) {
			prewarmPayloads.push(JSON.parse(payload) as Record<string, any>)
		},
		async *messages() {
			while (!prewarmClosed) {
				await new Promise(resolve => setTimeout(resolve, 10))
			}
		},
		close() {
			prewarmClosed = true
		},
		isClosed() {
			return prewarmClosed
		},
	}

	globalThis.fetch = mock(async () => {
		throw new Error('fetch should not be used when websocket transport succeeds')
	}) as typeof fetch

	setResponsesWebSocketFactoryForTests(async () => {
		websocketConnections += 1
		return websocketConnections === 1
			? pendingConnection
			: realtimeConnection.connection
	})

	const config = {
		providerName: 'openai' as const,
		baseURL: 'https://chatgpt.com/backend-api/codex',
		apiKey: 'codex-access-token',
		model: 'gpt-5.3-codex',
		thinkingMode: { type: 'none' } as const,
		useResponsesApi: true,
	}

	const prewarmPromise = scheduleResponsesStartupWebSocketPrewarm(config)

	const stream = await createResponsesApiStream(
		{
			model: 'claude-sonnet-4-20250514',
			max_tokens: 256,
			messages: [{ role: 'user', content: 'hello' }],
			stream: true,
		} as any,
		config,
	)

	for await (const _event of stream as AsyncIterable<Record<string, any>>) {
	}
	await prewarmPromise

	expect(prewarmPayloads[0]).toMatchObject({
		type: 'response.create',
		generate: false,
	})
	expect(prewarmClosed).toBe(true)
	expect(websocketConnections).toBe(2)
	expect(realtimeConnection.payloads[0]?.previous_response_id).toBeUndefined()
})

test('emits transport telemetry for startup prewarm and websocket request reuse', async () => {
	const analytics: Array<{ name: string; metadata: Record<string, unknown> }> = []
	setResponsesTelemetryHooksForTests({
		logEvent: (name, metadata) => {
			analytics.push({ name, metadata })
		},
		logForDiagnosticsNoPII: () => {},
		logForDebugging: () => {},
	})

	const connection = createMockReusableWebSocketConnection([
		{
			messages: [
				{ type: 'response.created', response: { id: 'warm-1' } },
				{
					type: 'response.completed',
					response: {
						id: 'warm-1',
						usage: { input_tokens: 0, output_tokens: 0 },
					},
				},
			],
		},
		{
			messages: [
				{ type: 'response.created', response: { id: 'resp-1' } },
				{
					type: 'response.output_text.delta',
					response: { id: 'resp-1' },
					delta: 'hello',
				},
				{
					type: 'response.completed',
					response: {
						id: 'resp-1',
						usage: { input_tokens: 2, output_tokens: 1 },
					},
				},
			],
		},
	])

	globalThis.fetch = mock(async () => {
		throw new Error('fetch should not be used when websocket transport succeeds')
	}) as typeof fetch

	setResponsesWebSocketFactoryForTests(async () => connection.connection)

	const config = {
		providerName: 'openai' as const,
		baseURL: 'https://chatgpt.com/backend-api/codex',
		apiKey: 'codex-access-token',
		model: 'gpt-5.3-codex',
		thinkingMode: { type: 'none' } as const,
		useResponsesApi: true,
	}

	await scheduleResponsesStartupWebSocketPrewarm(config)
	const stream = await createResponsesApiStream(
		{
			model: 'claude-sonnet-4-20250514',
			max_tokens: 256,
			messages: [{ role: 'user', content: 'hello' }],
			stream: true,
		} as any,
		config,
	)
	for await (const _event of stream as AsyncIterable<Record<string, any>>) {
	}

	const transportEvents = analytics.filter(
		event => event.name === 'tengu_openai_responses_transport',
	)
	expect(transportEvents).toHaveLength(2)
	expect(transportEvents[0]?.metadata).toMatchObject({
		transport: 'responses_websocket',
		phase: 'startup_prewarm',
		success: true,
		usedPreviousResponseId: false,
	})
	expect(transportEvents[1]?.metadata).toMatchObject({
		transport: 'responses_websocket',
		phase: 'request',
		success: true,
		connectionReused: true,
		usedPreviousResponseId: true,
	})
})

test('emits fallback telemetry when websocket setup fails and request succeeds over REST', async () => {
	const analytics: Array<{ name: string; metadata: Record<string, unknown> }> = []
	setResponsesTelemetryHooksForTests({
		logEvent: (name, metadata) => {
			analytics.push({ name, metadata })
		},
		logForDiagnosticsNoPII: () => {},
		logForDebugging: () => {},
	})

	setResponsesWebSocketFactoryForTests(async () => {
		throw new Error('websocket unavailable')
	})

	globalThis.fetch = mock(async () => {
		const sse = [
			'data: {"type":"response.created","response":{"id":"resp_rest"}}',
			'',
			'data: {"type":"response.output_text.delta","response":{"id":"resp_rest"},"delta":"fallback"}',
			'',
			'data: {"type":"response.completed","response":{"id":"resp_rest","usage":{"input_tokens":2,"output_tokens":1}}}',
			'',
		].join('\n') + '\n'

		return new Response(sse, {
			status: 200,
			headers: {
				'Content-Type': 'text/event-stream',
				'x-request-id': 'req-rest-1',
			},
		})
	}) as typeof fetch

	const stream = await createResponsesApiStream(
		{
			model: 'claude-sonnet-4-20250514',
			max_tokens: 256,
			messages: [{ role: 'user', content: 'hello' }],
			stream: true,
		} as any,
		{
			providerName: 'openai',
			baseURL: 'https://chatgpt.com/backend-api/codex',
			apiKey: 'codex-access-token',
			model: 'gpt-5.3-codex',
			thinkingMode: { type: 'none' },
			useResponsesApi: true,
		},
	)

	for await (const _event of stream as AsyncIterable<Record<string, any>>) {
	}

	expect(analytics).toContainEqual({
		name: 'tengu_openai_responses_transport_fallback',
		metadata: {
			phase: 'request',
			reason: 'websocket_setup_failed',
		},
	})
	expect(analytics).toContainEqual({
		name: 'tengu_openai_responses_transport',
		metadata: {
			transport: 'responses_http_fallback',
			phase: 'request',
			success: true,
			durationMs: expect.any(Number),
			connectionReused: undefined,
			usedPreviousResponseId: false,
			fellBackToRest: true,
			hasRequestId: true,
			hasCfRay: false,
			hasAuthError: false,
			hasAuthErrorCode: false,
		},
	})
})
