import { afterEach, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
	createResponsesApiStream,
	resetResponsesClientStateForTests,
} from '../responsesClient.js'

const ORIGINAL_FETCH = globalThis.fetch
const ORIGINAL_CODEX_HOME = process.env.CODEX_HOME

afterEach(() => {
	globalThis.fetch = ORIGINAL_FETCH
	resetResponsesClientStateForTests()
	if (ORIGINAL_CODEX_HOME === undefined) {
		delete process.env.CODEX_HOME
	} else {
		process.env.CODEX_HOME = ORIGINAL_CODEX_HOME
	}
})

test('sends store: false in Responses API requests', async () => {
	let requestBody: Record<string, unknown> | undefined
	const codexHome = mkdtempSync(join(tmpdir(), 'myclaw-responses-client-'))
	process.env.CODEX_HOME = codexHome

	try {
		globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
			requestBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
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
				messages: [
					{
						role: 'user',
						content: 'hello',
					},
				],
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

		expect(requestBody?.store).toBe(false)
		expect(requestBody?.stream).toBe(true)
	} finally {
		rmSync(codexHome, { recursive: true, force: true })
	}
})

test('does not send Anthropic tool_use ids as Responses function_call ids', async () => {
	let requestBody: Record<string, any> | undefined
	const codexHome = mkdtempSync(join(tmpdir(), 'myclaw-responses-client-'))
	process.env.CODEX_HOME = codexHome

	try {
		globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
			requestBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, any>
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
				messages: [
					{
						role: 'assistant',
						content: [
							{
								type: 'tool_use',
								id: 'call_LLK0lS6vtEChyd2Fk71LXPUx',
								name: 'Skill',
								input: { command: 'superpowers:using-superpowers' },
							},
						],
					},
					{
						role: 'user',
						content: [
							{
								type: 'tool_result',
								tool_use_id: 'call_LLK0lS6vtEChyd2Fk71LXPUx',
								content: 'ok',
							},
						],
					},
				],
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

		const functionCallItem = requestBody?.input?.[0]
		const functionCallOutputItem = requestBody?.input?.[1]

		expect(functionCallItem?.type).toBe('function_call')
		expect(functionCallItem?.id).toBeUndefined()
		expect(functionCallItem?.call_id).toBe('call_LLK0lS6vtEChyd2Fk71LXPUx')
		expect(functionCallOutputItem).toEqual({
			type: 'function_call_output',
			call_id: 'call_LLK0lS6vtEChyd2Fk71LXPUx',
			output: 'ok',
		})
	} finally {
		rmSync(codexHome, { recursive: true, force: true })
	}
})

test('replays preserved Responses function_call item ids separately from call_id', async () => {
	let requestBody: Record<string, any> | undefined
	const codexHome = mkdtempSync(join(tmpdir(), 'myclaw-responses-client-'))
	process.env.CODEX_HOME = codexHome

	try {
		globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
			requestBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, any>
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
				messages: [
					{
						role: 'assistant',
						content: [
							{
								type: 'tool_use',
								id: 'call_LLK0lS6vtEChyd2Fk71LXPUx',
								response_item_id: 'fc_1234567890',
								name: 'Skill',
								input: { command: 'superpowers:using-superpowers' },
							},
						],
					},
					{
						role: 'user',
						content: [
							{
								type: 'tool_result',
								tool_use_id: 'call_LLK0lS6vtEChyd2Fk71LXPUx',
								content: 'ok',
							},
						],
					},
				],
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

		const functionCallItem = requestBody?.input?.[0]
		const functionCallOutputItem = requestBody?.input?.[1]

		expect(functionCallItem).toEqual({
			type: 'function_call',
			id: 'fc_1234567890',
			call_id: 'call_LLK0lS6vtEChyd2Fk71LXPUx',
			name: 'Skill',
			arguments: '{"command":"superpowers:using-superpowers"}',
		})
		expect(functionCallOutputItem).toEqual({
			type: 'function_call_output',
			call_id: 'call_LLK0lS6vtEChyd2Fk71LXPUx',
			output: 'ok',
		})
	} finally {
		rmSync(codexHome, { recursive: true, force: true })
	}
})

test('exposes request_id and transport_info from Responses API headers', async () => {
	const codexHome = mkdtempSync(join(tmpdir(), 'myclaw-responses-client-'))
	process.env.CODEX_HOME = codexHome

	try {
		globalThis.fetch = mock(async () => {
			return new Response('', {
				status: 200,
				headers: {
					'Content-Type': 'text/event-stream',
					'x-request-id': 'req_transport_123',
					'cf-ray': 'ray-456',
				},
			})
		}) as typeof fetch

		const result = await createResponsesApiStream(
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
		).withResponse()

		expect(result.request_id).toBe('req_transport_123')
		expect(result.transport_info).toEqual({
			transport: 'responses_http_fallback',
			usedPreviousResponseId: false,
			fellBackToRest: true,
			connectionReused: undefined,
			requestId: 'req_transport_123',
			hasCfRay: true,
			hasAuthError: false,
			hasAuthErrorCode: false,
			statusCode: undefined,
			errorKind: undefined,
		})
	} finally {
		rmSync(codexHome, { recursive: true, force: true })
	}
})
