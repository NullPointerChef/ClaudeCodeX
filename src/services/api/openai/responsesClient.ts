/**
 * OpenAI Responses API client for Codex ChatGPT OAuth auth.
 *
 * ChatGPT Plus subscribers authenticate via OAuth tokens that work with
 * the Responses API at chatgpt.com/backend-api/codex, NOT the standard
 * Chat Completions API at api.openai.com/v1.
 *
 * This module translates Anthropic SDK params → Responses API request,
 * streams SSE events, and translates them back → Anthropic stream events.
 */
import type {
	BetaContentBlock,
	BetaMessage,
	BetaMessageStreamParams,
	BetaRawMessageStreamEvent,
	BetaStopReason,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type { TextBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import { getSessionId, onSessionSwitch } from '../../../bootstrap/state.js'
import { debugLog } from './debugLog.js'
import { FakeStream } from './streamAdapter.js'
import type { OpenAIProviderConfig } from './providerConfig.js'
import { ensureCodexToken } from './providerConfig.js'
import { myclawEffortToCodex } from './modelCatalog.js'
import {
	attachResponsesTransportErrorMetadata,
	createResponsesTransportSummary,
	recordResponsesStartupPrewarmTelemetry,
	recordResponsesTransportFallbackTelemetry,
	recordResponsesTransportTelemetry,
	type ResponsesTelemetryPhase,
	type ResponsesTransportName,
	type ResponsesTransportSummary,
} from './responsesTelemetry.js'
import {
	openResponsesWebSocket,
	type ResponsesWebSocketConnection,
} from './responsesWebSocketClient.js'

// ─── Responses API request types ──────────────────────────────────────────────

interface ResponsesInput {
	role: string
	content: ResponsesContent[] | string
	type?: string
}

type ResponsesContent =
	| { type: 'input_text'; text: string }
	| { type: 'input_image'; image_url: string }
	| { type: 'output_text'; text: string }

interface ResponsesTool {
	type: 'function'
	name: string
	description: string
	parameters: Record<string, unknown>
}

interface ResponsesFunctionCallOutput {
	type: 'function_call_output'
	call_id: string
	output: string
}

interface ResponsesFunctionCall {
	type: 'function_call'
	id?: string
	call_id: string
	name: string
	arguments: string
}

interface ResponsesApiRequest {
	model: string
	instructions: string
	input: Array<ResponsesInput | ResponsesFunctionCall | ResponsesFunctionCallOutput>
	tools: ResponsesTool[]
	tool_choice: string
	store: boolean
	stream: boolean
	previous_response_id?: string
	reasoning?: { effort: string }
}

interface ResponsesWebSocketRequest extends ResponsesApiRequest {
	type: 'response.create'
	generate?: boolean
}

interface ResponsesContinuationState {
	requestSignature: string
	input: ResponsesApiRequest['input']
	output: ResponsesApiRequest['input']
	responseId: string
}

interface CachedResponsesWebSocketSession {
	connection: ResponsesWebSocketConnection
	baseURL: string
	responseHeaders: Headers
	busy: boolean
}

interface ResponsesWebSocketLease {
	session: CachedResponsesWebSocketSession
	reused: boolean
	ephemeral: boolean
}

interface ResponsesStartupPrewarmState {
	baseURL: string
	abortController: AbortController
	promise: Promise<void>
	completed: boolean
	startedAt: number
}

interface ResponsesTransportTelemetryContext {
	transport: ResponsesTransportName
	phase: ResponsesTelemetryPhase
	connectionReused?: boolean
	usedPreviousResponseId: boolean
	fellBackToRest?: boolean
	responseHeaders?: Headers
}

const responsesContinuationState = new Map<string, ResponsesContinuationState>()
const responsesTurnState = new Map<string, string>()
const responsesWebSocketSessions = new Map<string, CachedResponsesWebSocketSession>()
const responsesStartupPrewarm = new Map<string, ResponsesStartupPrewarmState>()
const RESPONSES_WEBSOCKETS_BETA_HEADER_VALUE = 'responses_websockets=2026-02-06'
const RESPONSES_STARTUP_PREWARM_WAIT_MS = 250

export function resetResponsesClientStateForTests(): void {
	responsesContinuationState.clear()
	responsesTurnState.clear()
	for (const state of responsesStartupPrewarm.values()) {
		state.abortController.abort()
	}
	responsesStartupPrewarm.clear()
	for (const session of responsesWebSocketSessions.values()) {
		session.connection.close()
	}
	responsesWebSocketSessions.clear()
}

onSessionSwitch(() => {
	resetResponsesClientStateForTests()
})

// ─── SSE event types ──────────────────────────────────────────────────────────

interface ResponsesSSEEvent {
	type: string
	response?: Record<string, unknown>
	item?: Record<string, unknown>
	delta?: string
	item_id?: string
	output_index?: number
	content_index?: number
	summary_index?: number
}

interface ResponsesWrappedWebSocketErrorEvent {
	type: 'error'
	status?: number
	status_code?: number
	error?: {
		type?: string
		code?: string
		message?: string
	}
	headers?: Record<string, unknown>
}

// ─── Translation: Anthropic params → Responses API ────────────────────────────

function translateSystemPrompt(
	system: Array<TextBlockParam & { cache_control?: unknown }> | string | undefined,
): string {
	if (!system) return ''
	if (typeof system === 'string') return system
	return system.map((b) => b.text).join('\n\n')
}

function translateToResponsesRequest(
	params: BetaMessageStreamParams,
	config: OpenAIProviderConfig,
): ResponsesApiRequest {
	const instructions = translateSystemPrompt(params.system as any)
	const input: ResponsesApiRequest['input'] = []

	for (const msg of params.messages) {
		if (msg.role === 'user') {
			if (typeof msg.content === 'string') {
				input.push({ role: 'user', content: [{ type: 'input_text', text: msg.content }] })
			} else {
				const content: ResponsesContent[] = []
				const toolOutputs: ResponsesFunctionCallOutput[] = []

				for (const block of msg.content as Array<Record<string, any>>) {
					switch (block.type) {
						case 'text':
							content.push({ type: 'input_text', text: block.text })
							break
						case 'image': {
							const src = block.source
							if (src?.type === 'base64') {
								content.push({
									type: 'input_image',
									image_url: `data:${src.media_type};base64,${src.data}`,
								})
							} else if (src?.type === 'url') {
								content.push({ type: 'input_image', image_url: src.url })
							}
							break
						}
						case 'tool_result': {
							let outputText: string
							if (typeof block.content === 'string') {
								outputText = block.content
							} else if (Array.isArray(block.content)) {
								outputText = block.content
									.map((c: any) => (c.type === 'text' ? c.text : `[${c.type}]`))
									.join('\n')
							} else {
								outputText = block.content ? String(block.content) : ''
							}
							if (block.is_error) outputText = `[ERROR] ${outputText}`
							toolOutputs.push({
								type: 'function_call_output',
								call_id: block.tool_use_id,
								output: outputText,
							})
							break
						}
					}
				}

				// function_call_output must immediately follow the corresponding
				// function_call from the assistant turn. User content goes after.
				for (const to of toolOutputs) {
					input.push(to)
				}
				if (content.length > 0) {
					input.push({ role: 'user', content })
				}
			}
		} else if (msg.role === 'assistant') {
			if (typeof msg.content === 'string') {
				input.push({
					role: 'assistant',
					content: [{ type: 'output_text', text: msg.content }],
				})
			} else {
				const content: ResponsesContent[] = []
				const toolCalls: ResponsesFunctionCall[] = []

				for (const block of msg.content as Array<Record<string, any>>) {
					switch (block.type) {
						case 'text':
							content.push({ type: 'output_text', text: block.text })
							break
						case 'tool_use':
							const responseItemId =
								typeof block.response_item_id === 'string'
									? block.response_item_id
									: typeof block.responseItemId === 'string'
										? block.responseItemId
										: undefined
							toolCalls.push({
								type: 'function_call',
								// Responses function_call input items must not reuse Anthropic's
								// tool_use IDs as the OpenAI-managed item id. Preserve the
								// original Responses item id when available, and always use
								// call_id for tool_result linkage.
								...(responseItemId ? { id: responseItemId } : {}),
								call_id: block.id || `call_${Date.now()}`,
								name: block.name,
								arguments:
									typeof block.input === 'string'
										? block.input
										: JSON.stringify(block.input ?? {}),
							})
							break
					}
				}

				if (content.length > 0) {
					input.push({ role: 'assistant', content })
				}
				for (const tc of toolCalls) {
					input.push(tc)
				}
			}
		}
	}

	// Translate tools
	const tools: ResponsesTool[] = []
	if (params.tools?.length) {
		for (const t of params.tools as Array<Record<string, any>>) {
			if (!t.type || t.type === 'custom') {
				tools.push({
					type: 'function',
					name: t.name,
					description: t.description ?? '',
					parameters: t.input_schema as Record<string, unknown>,
				})
			}
		}
	}

	// Debug: log the final input sequence
	debugLog(`[DEBUG_OPENAI] responsesClient: input items=${input.length}`)
	for (const item of input.slice(-6)) {
		const t = 'type' in item ? (item as any).type : (item as any).role
		const preview = 'content' in item ? JSON.stringify((item as any).content)?.slice(0, 80) : ('output' in item ? (item as any).output?.slice(0, 80) : (item as any).name || '')
		debugLog(`[DEBUG_OPENAI]   ${t}: ${preview}`)
	}

	const request: ResponsesApiRequest = {
		model: config.model,
		instructions,
		input,
		tools,
		tool_choice: 'auto',
		// chatgpt.com/backend-api/codex rejects Responses requests unless store is
		// explicitly false. Sending it unconditionally is also valid for standard
		// Responses API semantics and keeps the payload consistent.
		store: false,
		stream: true,
	}

	// Add reasoning effort — prefer dynamic effort from params (output_config.effort)
	// over the static config.thinkingMode, so /effort commands take effect.
	const paramsEffort = (params as any).output_config?.effort as string | undefined
	if (paramsEffort) {
		request.reasoning = { effort: myclawEffortToCodex(paramsEffort as any) }
	} else if (config.thinkingMode.type === 'reasoning_effort') {
		request.reasoning = { effort: config.thinkingMode.level }
	}

	return request
}

function getResponsesRequestSignature(request: ResponsesApiRequest): string {
	return JSON.stringify({
		...request,
		input: [],
		previous_response_id: undefined,
	})
}

function serializeResponsesInput(
	input: ResponsesApiRequest['input'],
): string[] {
	return input.map(item => JSON.stringify(item))
}

function getIncrementalResponsesRequest(
	sessionId: string,
	request: ResponsesApiRequest,
): ResponsesApiRequest {
	const previousState = responsesContinuationState.get(sessionId)
	if (!previousState) {
		return request
	}

	const requestSignature = getResponsesRequestSignature(request)
	if (previousState.requestSignature !== requestSignature) {
		return request
	}

	const baselineInput = [...previousState.input, ...previousState.output]
	const baselineSerialized = serializeResponsesInput(baselineInput)
	const currentSerialized = serializeResponsesInput(request.input)

	if (currentSerialized.length <= baselineSerialized.length) {
		return request
	}

	for (let i = 0; i < baselineSerialized.length; i++) {
		if (baselineSerialized[i] !== currentSerialized[i]) {
			return request
		}
	}

	return {
		...request,
		previous_response_id: previousState.responseId,
		input: request.input.slice(baselineInput.length),
	}
}

function isCodexChatGPTResponsesEndpoint(baseURL: string): boolean {
	return baseURL.startsWith('https://chatgpt.com/backend-api/codex')
}

function shouldUseCodexResponsesWebSocket(
	config: OpenAIProviderConfig,
): boolean {
	return config.useResponsesApi === true && isCodexChatGPTResponsesEndpoint(config.baseURL)
}

function supportsPreviousResponseId(baseURL: string): boolean {
	// Codex CLI only uses previous_response_id on the websocket transport.
	// The ChatGPT Codex REST endpoint rejects this field with:
	// "Unsupported parameter: previous_response_id".
	return !isCodexChatGPTResponsesEndpoint(baseURL)
}

function trackResponsesContinuation(
	sessionId: string,
	request: ResponsesApiRequest,
	sseStream: AsyncGenerator<ResponsesSSEEvent>,
	options?: { clearOnEndTurn?: boolean },
): AsyncGenerator<ResponsesSSEEvent> {
	return (async function* () {
		let responseId: string | undefined
		let completed = false
		let continuationCommitted = false
		let assistantText = ''
		let hasToolCalls = false
		const functionCalls = new Map<string, ResponsesFunctionCall>()
		const commitContinuationState = () => {
			if (continuationCommitted || !completed) {
				return
			}

			if (options?.clearOnEndTurn && !hasToolCalls) {
				responsesContinuationState.delete(sessionId)
				continuationCommitted = true
				return
			}

			if (!responseId) {
				return
			}

			const output: ResponsesApiRequest['input'] = []
			if (assistantText.length > 0) {
				output.push({
					role: 'assistant',
					content: [{ type: 'output_text', text: assistantText }],
				})
			}
			output.push(...functionCalls.values())
			responsesContinuationState.set(sessionId, {
				requestSignature: getResponsesRequestSignature(request),
				input: request.input,
				output,
				responseId,
			})
			continuationCommitted = true
		}

		try {
			for await (const event of sseStream) {
				const eventResponseId =
					typeof event.response?.id === 'string'
						? (event.response.id as string)
						: undefined
				if (eventResponseId) {
					responseId = eventResponseId
				}

				switch (event.type) {
					case 'response.output_text.delta':
						assistantText += event.delta ?? ''
						break
					case 'response.output_item.added': {
						const item = event.item
						if (!item || item.type !== 'function_call') {
							break
						}
						const itemId = typeof item.id === 'string' ? item.id : undefined
						const callId =
							typeof item.call_id === 'string'
								? item.call_id
								: itemId ?? `call_${Date.now()}`
						hasToolCalls = true
						functionCalls.set(itemId ?? callId, {
							type: 'function_call',
							...(itemId ? { id: itemId } : {}),
							call_id: callId,
							name: (item.name ?? '') as string,
							arguments:
								typeof item.arguments === 'string' ? item.arguments : '',
						})
						break
					}
					case 'response.function_call_arguments.delta': {
						if (typeof event.item_id !== 'string' || !event.delta) {
							break
						}
						const functionCall = functionCalls.get(event.item_id)
						if (functionCall) {
							functionCall.arguments += event.delta
						}
						break
					}
					case 'response.output_item.done': {
						const item = event.item
						if (!item || item.type !== 'function_call') {
							break
						}
						const itemId = typeof item.id === 'string' ? item.id : undefined
						const callId =
							typeof item.call_id === 'string' ? item.call_id : undefined
						const functionCall =
							(itemId ? functionCalls.get(itemId) : undefined) ??
							(callId ? functionCalls.get(callId) : undefined)
						if (functionCall) {
							functionCall.name = (item.name ?? functionCall.name) as string
							if (typeof item.arguments === 'string') {
								functionCall.arguments = item.arguments
							}
						}
						break
					}
					case 'response.completed':
						completed = true
						commitContinuationState()
						break
				}

				yield event
			}
		} finally {
			commitContinuationState()
		}
	})()
}

function trackResponsesTurnState(
	sessionId: string,
	sseStream: AsyncGenerator<ResponsesSSEEvent>,
): AsyncGenerator<ResponsesSSEEvent> {
	return (async function* () {
		let completed = false
		let hasToolCalls = false

		try {
			for await (const event of sseStream) {
				if (
					event.type === 'response.output_item.added' &&
					event.item?.type === 'function_call'
				) {
					hasToolCalls = true
				} else if (event.type === 'response.completed') {
					completed = true
				}

				yield event
			}
		} finally {
			if (completed && !hasToolCalls) {
				responsesTurnState.delete(sessionId)
			}
		}
	})()
}

function classifyResponsesTransportError(error: unknown): string {
	if (error instanceof Error) {
		const message = error.message.toLowerCase()
		if (message.includes('aborted')) return 'aborted'
		if (message.includes('timeout')) return 'timeout'
		if (message.includes('response failed')) return 'response_failed'
		if (
			message.includes('websocket') ||
			message.includes('socket') ||
			message.includes('closed before completion')
		) {
			return 'stream'
		}
	}
	return 'unknown'
}

function headersFromResponsesWebSocketError(
	headers: ResponsesWrappedWebSocketErrorEvent['headers'],
): Headers {
	const mapped = new Headers()
	if (!headers) {
		return mapped
	}

	for (const [name, value] of Object.entries(headers)) {
		if (
			typeof value === 'string' ||
			typeof value === 'number' ||
			typeof value === 'boolean'
		) {
			mapped.set(name, String(value))
		}
	}

	return mapped
}

function parseResponsesWrappedWebSocketErrorEvent(
	payload: string,
): ResponsesWrappedWebSocketErrorEvent | null {
	try {
		const parsed = JSON.parse(payload) as Record<string, unknown>
		if (parsed.type !== 'error') {
			return null
		}
		return parsed as ResponsesWrappedWebSocketErrorEvent
	} catch {
		return null
	}
}

function createResponsesWrappedWebSocketError(
	payload: string,
	lease: ResponsesWebSocketLease,
	request: ResponsesApiRequest,
): Error {
	const parsed = parseResponsesWrappedWebSocketErrorEvent(payload)
	if (!parsed) {
		return new Error(`Responses websocket error: ${payload}`)
	}

	const statusCode =
		typeof parsed.status === 'number'
			? parsed.status
			: typeof parsed.status_code === 'number'
				? parsed.status_code
				: undefined
	const responseHeaders = headersFromResponsesWebSocketError(parsed.headers)
	const transportInfo = createResponsesTransportSummary({
		transport: 'responses_websocket',
		connectionReused: lease.reused,
		usedPreviousResponseId: request.previous_response_id !== undefined,
		responseHeaders,
		statusCode,
		errorKind: statusCode !== undefined ? 'http_status' : 'stream',
	})

	return attachResponsesTransportErrorMetadata(
		new Error(
			statusCode !== undefined
				? `Responses API error ${statusCode}: ${payload}`
				: `Responses websocket error: ${payload}`,
		),
		{
			requestId: transportInfo.requestId,
			responseHeaders,
			transportInfo,
		},
	)
}

function trackResponsesTransportTelemetry(
	sseStream: AsyncGenerator<ResponsesSSEEvent>,
	context: ResponsesTransportTelemetryContext,
): AsyncGenerator<ResponsesSSEEvent> {
	return (async function* () {
		const startedAt = Date.now()
		let responseId: string | undefined
		let success = false
		let errorKind: string | undefined

		try {
			for await (const event of sseStream) {
				if (typeof event.response?.id === 'string') {
					responseId = event.response.id as string
				}
				if (event.type === 'response.failed') {
					errorKind = 'response_failed'
				} else if (event.type === 'response.completed') {
					success = true
				}
				yield event
			}
		} catch (error) {
			errorKind ??= classifyResponsesTransportError(error)
			throw error
		} finally {
			recordResponsesTransportTelemetry({
				transport: context.transport,
				phase: context.phase,
				success,
				durationMs: Date.now() - startedAt,
				connectionReused: context.connectionReused,
				usedPreviousResponseId: context.usedPreviousResponseId,
				fellBackToRest: context.fellBackToRest,
				responseHeaders: context.responseHeaders,
				responseId,
				errorKind,
			})
		}
	})()
}

// ─── SSE stream reader ───────────────────────────────────────────────────────

async function* readSSEStream(
	response: Response,
	abortController: AbortController,
): AsyncGenerator<ResponsesSSEEvent> {
	const reader = response.body!.getReader()
	const decoder = new TextDecoder()
	let buffer = ''

	try {
		while (true) {
			if (abortController.signal.aborted) break

			const { done, value } = await reader.read()
			if (done) break

			buffer += decoder.decode(value, { stream: true })

			// Parse SSE events from buffer
			const lines = buffer.split('\n')
			buffer = lines.pop()! // Keep incomplete line

			let currentData = ''
			for (const line of lines) {
				if (line.startsWith('data: ')) {
					currentData += line.slice(6)
				} else if (line === '' && currentData) {
					// Empty line = end of event
					try {
						const event = JSON.parse(currentData) as ResponsesSSEEvent
						debugLog(`[DEBUG_OPENAI] readSSEStream: event type=${event.type}`)
						yield event
					} catch {
						debugLog(`[DEBUG_OPENAI] readSSEStream: malformed event data=${currentData.slice(0, 200)}`)
					}
					currentData = ''
				}
			}
		}
	} finally {
		reader.releaseLock()
	}
}

// ─── SSE → Anthropic stream translation ──────────────────────────────────────

async function* translateResponsesStream(
	sseStream: AsyncGenerator<ResponsesSSEEvent>,
	model: string,
	abortController: AbortController,
): AsyncGenerator<BetaRawMessageStreamEvent> {
	let messageStarted = false
	let nextBlockIndex = 0
	let textBlockIndex = -1
	let textBlockOpen = false
	let inputTokens = 0
	let outputTokens = 0

	// Track tool calls from output_item.added / output_item.done
	const toolBlockIndicesByCallId = new Map<string, number>()
	const toolBlockIndicesByItemId = new Map<string, number>()

	debugLog('[DEBUG_OPENAI] translateResponsesStream: starting')
	try {
		for await (const event of sseStream) {
			if (abortController.signal.aborted) break

			debugLog(`[DEBUG_OPENAI] translateResponsesStream event: type=${event.type}`)

			// ── message_start (once) ──
			if (!messageStarted && (
				event.type === 'response.created' ||
				event.type === 'response.output_text.delta' ||
				event.type === 'response.output_item.added'
			)) {
				messageStarted = true
				yield {
					type: 'message_start',
					message: {
						id: (event.response?.id as string) || `msg_${Date.now()}`,
						type: 'message',
						role: 'assistant',
						model,
						content: [],
						stop_reason: null,
						stop_sequence: null,
						usage: {
							input_tokens: 0,
							output_tokens: 0,
							cache_creation_input_tokens: 0,
							cache_read_input_tokens: 0,
						},
					},
				} as BetaRawMessageStreamEvent
			}

			switch (event.type) {
				case 'response.output_text.delta': {
					if (!textBlockOpen) {
						textBlockOpen = true
						textBlockIndex = nextBlockIndex++
						yield {
							type: 'content_block_start',
							index: textBlockIndex,
							content_block: { type: 'text', text: '' },
						} as BetaRawMessageStreamEvent
					}
					if (event.delta) {
						yield {
							type: 'content_block_delta',
							index: textBlockIndex,
							delta: { type: 'text_delta', text: event.delta },
						} as BetaRawMessageStreamEvent
					}
					break
				}

				case 'response.output_item.added': {
					const item = event.item
					if (!item) break
					const itemType = item.type as string

					if (itemType === 'function_call') {
						// Close text block if open
						if (textBlockOpen) {
							textBlockOpen = false
							yield {
								type: 'content_block_stop',
								index: textBlockIndex,
							} as BetaRawMessageStreamEvent
						}

						const callId = (item.call_id ?? item.id ?? `call_${Date.now()}`) as string
						const itemId =
							typeof item.id === 'string' ? item.id : undefined
						const blockIdx = nextBlockIndex++
						toolBlockIndicesByCallId.set(callId, blockIdx)
						if (itemId) {
							toolBlockIndicesByItemId.set(itemId, blockIdx)
						}
						yield {
							type: 'content_block_start',
							index: blockIdx,
							content_block: {
								type: 'tool_use',
								id: callId,
								response_item_id: itemId,
								name: (item.name ?? '') as string,
								input: {},
							},
						} as BetaRawMessageStreamEvent
					}
					break
				}

				case 'response.function_call_arguments.delta': {
					if (event.delta) {
						const blockIdx =
							(typeof event.item_id === 'string'
								? toolBlockIndicesByItemId.get(event.item_id)
								: undefined) ??
							undefined
						if (blockIdx !== undefined) {
							yield {
								type: 'content_block_delta',
								index: blockIdx,
								delta: {
									type: 'input_json_delta',
									partial_json: event.delta,
								},
							} as BetaRawMessageStreamEvent
						}
					}
					break
				}

				case 'response.output_item.done': {
					const item = event.item
					if (!item) break
					const itemType = item.type as string

					if (itemType === 'function_call') {
						const callId = typeof item.call_id === 'string' ? item.call_id : undefined
						const itemId = typeof item.id === 'string' ? item.id : undefined
						const blockIdx =
							(itemId ? toolBlockIndicesByItemId.get(itemId) : undefined) ??
							(callId ? toolBlockIndicesByCallId.get(callId) : undefined)
						if (blockIdx !== undefined) {
							yield {
								type: 'content_block_delta',
								index: blockIdx,
								delta: {
									type: 'input_json_delta',
									partial_json: '',
								},
							} as BetaRawMessageStreamEvent
							yield {
								type: 'content_block_stop',
								index: blockIdx,
							} as BetaRawMessageStreamEvent
						}
					}
					break
				}

				case 'response.completed': {
					const resp = event.response
					const usage = resp?.usage as Record<string, any> | undefined

					// Close open text block
					if (textBlockOpen) {
						textBlockOpen = false
						yield {
							type: 'content_block_stop',
							index: textBlockIndex,
						} as BetaRawMessageStreamEvent
					}

					// Close any remaining tool blocks
					for (const [, blockIdx] of toolBlockIndicesByCallId) {
						// Already closed in output_item.done, skip
					}

					if (usage) {
						inputTokens = usage.input_tokens ?? 0
						outputTokens = usage.output_tokens ?? 0
					}

					const hasToolCalls = toolBlockIndicesByCallId.size > 0
					const stopReason: BetaStopReason = hasToolCalls ? 'tool_use' : 'end_turn'

					yield {
						type: 'message_delta',
						context_management: null,
						delta: {
							stop_reason: stopReason,
							stop_sequence: null,
							container: null,
						},
						usage: {
							output_tokens: outputTokens,
							cache_creation_input_tokens: null,
							cache_read_input_tokens: null,
							input_tokens: inputTokens,
							iterations: null,
						},
					} as BetaRawMessageStreamEvent
					yield { type: 'message_stop' } as BetaRawMessageStreamEvent
					return
				}

				case 'response.failed': {
					const resp = event.response
					const error = resp?.error as Record<string, any> | undefined
					const message = error?.message ?? 'Responses API request failed'
					debugLog(`[DEBUG_OPENAI] translateResponsesStream: response.failed error=${message}`)
					throw new Error(String(message))
				}
			}
		}
		debugLog(`[DEBUG_OPENAI] translateResponsesStream: stream ended normally, messageStarted=${messageStarted}`)
	} catch (err) {
		debugLog(`[DEBUG_OPENAI] translateResponsesStream: catch error=${err instanceof Error ? err.message : String(err)}, aborted=${abortController.signal.aborted}`)
		if (abortController.signal.aborted) return
		throw err
	}
}

// ─── WebSocket transport ─────────────────────────────────────────────────────

function destroyResponsesWebSocketSession(
	sessionId: string,
	lease: ResponsesWebSocketLease,
): void {
	if (responsesWebSocketSessions.get(sessionId) === lease.session) {
		responsesWebSocketSessions.delete(sessionId)
	}
	lease.session.busy = false
	lease.session.connection.close()
}

function releaseResponsesWebSocketSession(
	sessionId: string,
	lease: ResponsesWebSocketLease,
): void {
	if (lease.ephemeral) {
		lease.session.busy = false
		lease.session.connection.close()
		return
	}

	const cachedSession = responsesWebSocketSessions.get(sessionId)
	if (cachedSession !== lease.session) {
		lease.session.busy = false
		lease.session.connection.close()
		return
	}

	lease.session.busy = false
	if (lease.session.connection.isClosed()) {
		responsesWebSocketSessions.delete(sessionId)
	}
}

function getResponsesWebSocketUrl(baseURL: string): string {
	const url = new URL(baseURL)
	url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
	url.pathname = `${url.pathname.replace(/\/$/, '')}/responses`
	return url.toString()
}

function toResponsesWebSocketRequest(
	request: ResponsesApiRequest,
	options?: { generate?: boolean },
): ResponsesWebSocketRequest {
	return {
		type: 'response.create',
		...request,
		...(options?.generate !== undefined ? { generate: options.generate } : {}),
	}
}

function createStartupPrewarmRequest(
	config: OpenAIProviderConfig,
): ResponsesApiRequest {
	const request: ResponsesApiRequest = {
		model: config.model,
		instructions: '',
		input: [],
		tools: [],
		tool_choice: 'auto',
		store: false,
		stream: true,
	}

	if (config.thinkingMode.type === 'reasoning_effort') {
		request.reasoning = { effort: config.thinkingMode.level }
	}

	return request
}

async function acquireResponsesWebSocketSession(
	sessionId: string,
	apiKey: string,
	config: OpenAIProviderConfig,
	options: ResponsesApiStreamOptions | undefined,
	abortController: AbortController,
): Promise<ResponsesWebSocketLease> {
	const cachedSession = responsesWebSocketSessions.get(sessionId)
	if (cachedSession) {
		const incompatibleSession =
			cachedSession.baseURL !== config.baseURL || cachedSession.connection.isClosed()
		if (incompatibleSession) {
			destroyResponsesWebSocketSession(sessionId, {
				session: cachedSession,
				reused: false,
				ephemeral: false,
			})
		} else if (!cachedSession.busy) {
			cachedSession.busy = true
			return {
				session: cachedSession,
				reused: true,
				ephemeral: false,
			}
		}
	}

	const headers = new Headers(options?.headers)
	headers.set('Authorization', `Bearer ${apiKey}`)
	headers.set('x-client-request-id', sessionId)
	headers.set('session_id', sessionId)
	headers.set('OpenAI-Beta', RESPONSES_WEBSOCKETS_BETA_HEADER_VALUE)

	const turnState = responsesTurnState.get(sessionId)
	if (turnState) {
		headers.set('x-codex-turn-state', turnState)
	}

	const connection = await openResponsesWebSocket({
		url: getResponsesWebSocketUrl(config.baseURL),
		headers: Object.fromEntries(headers.entries()),
		signal: abortController.signal,
	})
	const newSession: CachedResponsesWebSocketSession = {
		connection,
		baseURL: config.baseURL,
		responseHeaders: connection.responseHeaders,
		busy: true,
	}

	const shouldCache = !responsesWebSocketSessions.has(sessionId)
	if (shouldCache) {
		responsesWebSocketSessions.set(sessionId, newSession)
	}

	return {
		session: newSession,
		reused: false,
		ephemeral: !shouldCache,
	}
}

async function* readResponsesWebSocketStream(
	sessionId: string,
	lease: ResponsesWebSocketLease,
	request: ResponsesApiRequest,
	abortController: AbortController,
): AsyncGenerator<ResponsesSSEEvent> {
	let sawTerminalEvent = false
	let requestFailed = false

	try {
		for await (const message of lease.session.connection.messages()) {
			if (abortController.signal.aborted) {
				break
			}

			const wrappedError =
				parseResponsesWrappedWebSocketErrorEvent(message)
			if (wrappedError) {
				requestFailed = true
				throw createResponsesWrappedWebSocketError(message, lease, request)
			}

			try {
				const event = JSON.parse(message) as ResponsesSSEEvent
				if (typeof event.type === 'string') {
					if (event.type === 'response.failed') {
						requestFailed = true
						sawTerminalEvent = true
						yield event
						break
					}
					if (event.type === 'response.completed') {
						sawTerminalEvent = true
						yield event
						break
					}
					yield event
				}
			} catch {
				// Ignore malformed websocket frames.
			}
		}

		if (!sawTerminalEvent && !abortController.signal.aborted) {
			requestFailed = true
			throw new Error('Responses websocket stream closed before completion')
		}
	} finally {
		if (abortController.signal.aborted || requestFailed) {
			responsesTurnState.delete(sessionId)
			responsesContinuationState.delete(sessionId)
			destroyResponsesWebSocketSession(sessionId, lease)
		} else if (lease.session.connection.isClosed()) {
			destroyResponsesWebSocketSession(sessionId, lease)
		} else {
			releaseResponsesWebSocketSession(sessionId, lease)
		}
	}
}

async function createResponsesWebSocketSseStreamInternal(
	sessionId: string,
	request: ResponsesApiRequest,
	apiKey: string,
	config: OpenAIProviderConfig,
	options: ResponsesApiStreamOptions | undefined,
	abortController: AbortController,
	requestOptions?: {
		generate?: boolean
		trackContinuation?: boolean
		clearContinuationOnEndTurn?: boolean
		trackTurnState?: boolean
	},
): Promise<{
	responseHeaders: Headers
	sseStream: AsyncGenerator<ResponsesSSEEvent>
	connectionReused: boolean
}> {
	const lease = await acquireResponsesWebSocketSession(
		sessionId,
		apiKey,
		config,
		options,
		abortController,
	)

	const responseTurnState = !lease.reused
		? lease.session.responseHeaders.get('x-codex-turn-state')
		: null
	if (requestOptions?.trackTurnState !== false && responseTurnState) {
		responsesTurnState.set(sessionId, responseTurnState)
	}

	try {
		await lease.session.connection.send(
			JSON.stringify(
				toResponsesWebSocketRequest(request, {
					generate: requestOptions?.generate,
				}),
			),
		)
	} catch (error) {
		responsesTurnState.delete(sessionId)
		responsesContinuationState.delete(sessionId)
		destroyResponsesWebSocketSession(sessionId, lease)
		throw error
	}

	const rawStream = readResponsesWebSocketStream(
		sessionId,
		lease,
		request,
		abortController,
	)
	const continuationStream =
		requestOptions?.trackContinuation === false
			? rawStream
			: trackResponsesContinuation(
					sessionId,
					request,
					rawStream,
					requestOptions?.clearContinuationOnEndTurn
						? { clearOnEndTurn: true }
						: undefined,
				)

	return {
		responseHeaders: lease.session.responseHeaders,
		sseStream:
			requestOptions?.trackTurnState === false
				? continuationStream
				: trackResponsesTurnState(sessionId, continuationStream),
		connectionReused: lease.reused,
	}
}

async function createResponsesWebSocketSseStream(
	sessionId: string,
	request: ResponsesApiRequest,
	apiKey: string,
	config: OpenAIProviderConfig,
	options: ResponsesApiStreamOptions | undefined,
	abortController: AbortController,
): Promise<{
	responseHeaders: Headers
	sseStream: AsyncGenerator<ResponsesSSEEvent>
	connectionReused: boolean
}> {
	return createResponsesWebSocketSseStreamInternal(
		sessionId,
		request,
		apiKey,
		config,
		options,
		abortController,
		{
			trackContinuation: true,
			clearContinuationOnEndTurn: true,
			trackTurnState: true,
		},
	)
}

async function waitForResponsesStartupWebSocketPrewarm(
	sessionId: string,
	config: OpenAIProviderConfig,
): Promise<void> {
	const state = responsesStartupPrewarm.get(sessionId)
	if (!state || state.baseURL !== config.baseURL || state.completed) {
		return
	}

	try {
		let timedOut = false
		await Promise.race([
			state.promise,
			new Promise<void>(resolve => {
				setTimeout(() => {
					timedOut = true
					resolve()
				}, RESPONSES_STARTUP_PREWARM_WAIT_MS)
			}),
		])
		if (timedOut && !state.completed) {
			state.abortController.abort()
			if (responsesStartupPrewarm.get(sessionId) === state) {
				responsesStartupPrewarm.delete(sessionId)
			}
			responsesTurnState.delete(sessionId)
			responsesContinuationState.delete(sessionId)
			const cachedSession = responsesWebSocketSessions.get(sessionId)
			if (
				cachedSession &&
				cachedSession.baseURL === config.baseURL &&
				cachedSession.busy
			) {
				responsesWebSocketSessions.delete(sessionId)
				cachedSession.busy = false
				cachedSession.connection.close()
			}
			recordResponsesStartupPrewarmTelemetry({
				status: 'cancelled',
				reason: 'timeout',
				durationMs: Date.now() - state.startedAt,
			})
		}
	} catch {
		// Prewarm is best-effort only.
	}
}

export function scheduleResponsesStartupWebSocketPrewarm(
	config: OpenAIProviderConfig,
): Promise<void> {
	if (!shouldUseCodexResponsesWebSocket(config)) {
		return Promise.resolve()
	}

	const sessionId = getSessionId()
	const existingState = responsesStartupPrewarm.get(sessionId)
	if (existingState?.baseURL === config.baseURL) {
		return existingState.promise
	}
	if (existingState) {
		existingState.abortController.abort()
		responsesStartupPrewarm.delete(sessionId)
		recordResponsesStartupPrewarmTelemetry({
			status: 'cancelled',
			reason: 'superseded',
			durationMs: Date.now() - existingState.startedAt,
		})
	}

	const abortController = new AbortController()
	const state: ResponsesStartupPrewarmState = {
		baseURL: config.baseURL,
		abortController,
		completed: false,
		startedAt: Date.now(),
		promise: Promise.resolve(),
	}

	state.promise = (async () => {
		let failureReason: 'setup_failed' | 'stream_failed' = 'setup_failed'
		let apiKey = config.apiKey
		if (config.useResponsesApi) {
			const freshToken = await ensureCodexToken()
			if (freshToken) apiKey = freshToken
		}

		const request = createStartupPrewarmRequest(config)
		const websocketStream = await createResponsesWebSocketSseStreamInternal(
			sessionId,
			request,
			apiKey,
			config,
			undefined,
			abortController,
			{
				generate: false,
				trackContinuation: true,
				clearContinuationOnEndTurn: false,
				trackTurnState: false,
			},
		)
		failureReason = 'stream_failed'

		const telemetryStream = trackResponsesTransportTelemetry(
			websocketStream.sseStream,
			{
				transport: 'responses_websocket',
				phase: 'startup_prewarm',
				connectionReused: websocketStream.connectionReused,
				usedPreviousResponseId: false,
				responseHeaders: websocketStream.responseHeaders,
			},
		)

		for await (const event of telemetryStream) {
			if (event.type === 'response.failed') {
				const error = event.response?.error as { message?: unknown } | undefined
				throw new Error(
					typeof error?.message === 'string'
						? error.message
						: 'Responses startup prewarm failed',
				)
			}
		}
	})()
		.catch(() => {
			if (!abortController.signal.aborted) {
				recordResponsesStartupPrewarmTelemetry({
					status: 'failed',
					reason: failureReason,
					durationMs: Date.now() - state.startedAt,
				})
			}
			// Startup prewarm is best-effort and should fail open.
		})
		.finally(() => {
			state.completed = true
		})

	responsesStartupPrewarm.set(sessionId, state)
	return state.promise
}

// ─── Exported PromiseWithResponse type ────────────────────────────────────────

type PromiseWithResponse = Promise<FakeStream | BetaMessage> & {
	withResponse(): Promise<{
		data: FakeStream | BetaMessage
		request_id: string | null
		transport_info?: ResponsesTransportSummary
		response: { headers: Headers }
	}>
}

interface ResponsesApiResponseInfo {
	headers: Headers
	requestId: string | null
	transportInfo?: ResponsesTransportSummary
}

type ResponsesApiStreamOptions = {
	signal?: AbortSignal
	timeout?: number
	headers?: Record<string, string>
}

function makePromiseWithResponse(
	promise: Promise<FakeStream | BetaMessage>,
	responseInfoPromise: Promise<ResponsesApiResponseInfo>,
): PromiseWithResponse {
	const p = promise as PromiseWithResponse
	p.withResponse = async () => {
		const [data, responseInfo] = await Promise.all([promise, responseInfoPromise])
		return {
			data,
			request_id: responseInfo.requestId,
			transport_info: responseInfo.transportInfo,
			response: { headers: responseInfo.headers },
		}
	}
	return p
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function createResponsesApiStream(
	params: BetaMessageStreamParams,
	config: OpenAIProviderConfig,
	options?: ResponsesApiStreamOptions,
): PromiseWithResponse {
	let resolveResponseInfo: (info: ResponsesApiResponseInfo) => void = () => {}
	const responseInfoPromise = new Promise<ResponsesApiResponseInfo>(resolve => {
		resolveResponseInfo = resolve
	})
	const streamPromise = (async () => {
		// Ensure we have a valid token (refresh if expired)
		let apiKey = config.apiKey
		if (config.useResponsesApi) {
			const freshToken = await ensureCodexToken()
			if (freshToken) apiKey = freshToken
		}

		const fullRequest = translateToResponsesRequest(params, config)
		const abortController = new AbortController()
		const sessionId = getSessionId()
		const useCodexWebSocket = shouldUseCodexResponsesWebSocket(config)
		debugLog(`[DEBUG_OPENAI] responsesClient: transport useCodexWebSocket=${useCodexWebSocket}, baseURL=${config.baseURL}`)
		if (useCodexWebSocket) {
			await waitForResponsesStartupWebSocketPrewarm(sessionId, config)
		}
		// Disable previous_response_id for Codex WebSocket — the response IDs
		// are connection-scoped and cannot be reused across WebSocket sessions.
		const canUsePreviousResponseId = supportsPreviousResponseId(config.baseURL)
		const request = canUsePreviousResponseId
			? getIncrementalResponsesRequest(sessionId, fullRequest)
			: fullRequest
		const usedPreviousResponseId = request.previous_response_id !== undefined

		if (options?.signal) {
			if (options.signal.aborted) {
				abortController.abort()
			} else {
				options.signal.addEventListener('abort', () => abortController.abort())
			}
		}

		try {
			let responseHeaders = new Headers()
			let sseStream: AsyncGenerator<ResponsesSSEEvent>
			let transportInfo: ResponsesTransportSummary | undefined

			if (useCodexWebSocket) {
				debugLog(`[DEBUG_OPENAI] responsesClient: trying WebSocket transport`)
				try {
					const websocketStream = await createResponsesWebSocketSseStream(
						sessionId,
						request,
						apiKey,
						config,
						options,
						abortController,
					)
					responseHeaders = websocketStream.responseHeaders
					transportInfo = createResponsesTransportSummary({
						transport: 'responses_websocket',
						connectionReused: websocketStream.connectionReused,
						usedPreviousResponseId,
						responseHeaders,
					})
					sseStream = trackResponsesTransportTelemetry(
						websocketStream.sseStream,
						{
							transport: 'responses_websocket',
							phase: 'request',
							connectionReused: websocketStream.connectionReused,
							usedPreviousResponseId,
							responseHeaders,
						},
					)
				} catch (wsErr) {
					debugLog(`[DEBUG_OPENAI] responsesClient: WebSocket failed, falling back to HTTP. error=${wsErr instanceof Error ? wsErr.message : String(wsErr)}`)
					recordResponsesTransportFallbackTelemetry({
						phase: 'request',
						reason: 'websocket_setup_failed',
					})
					const url = `${config.baseURL}/responses`
					const headers = new Headers(options?.headers)
					headers.set('Content-Type', 'application/json')
					headers.set('Authorization', `Bearer ${apiKey}`)
					headers.set('Accept', 'text/event-stream')
					headers.set('x-client-request-id', sessionId)
					headers.set('session_id', sessionId)
					const fallbackStartTime = Date.now()
					let recordedFallbackFailure = false
					try {
						debugLog(`[DEBUG_OPENAI] responsesClient fallback HTTP: POST ${url}`)
						const resp = await fetch(url, {
							method: 'POST',
							headers,
							body: JSON.stringify(fullRequest),
							signal: abortController.signal,
						})
						debugLog(`[DEBUG_OPENAI] responsesClient fallback HTTP: status=${resp.status}`)

						if (!resp.ok) {
							const transportHeaders = new Headers(resp.headers)
							const errorTransportInfo = createResponsesTransportSummary({
								transport: 'responses_http_fallback',
								usedPreviousResponseId: false,
								fellBackToRest: true,
								responseHeaders: transportHeaders,
								statusCode: resp.status,
								errorKind: 'http_status',
							})
							recordResponsesTransportTelemetry({
								transport: 'responses_http_fallback',
								phase: 'request',
								success: false,
								durationMs: Date.now() - fallbackStartTime,
								usedPreviousResponseId: false,
								fellBackToRest: true,
								responseHeaders: transportHeaders,
								statusCode: resp.status,
								errorKind: 'http_status',
							})
							recordedFallbackFailure = true
							const body = await resp.text().catch(() => '')
							throw attachResponsesTransportErrorMetadata(
								new Error(`Responses API error ${resp.status}: ${body}`),
								{
									requestId: errorTransportInfo.requestId,
									responseHeaders: transportHeaders,
									transportInfo: errorTransportInfo,
								},
							)
						}

						responseHeaders = new Headers(resp.headers)
						transportInfo = createResponsesTransportSummary({
							transport: 'responses_http_fallback',
							usedPreviousResponseId: false,
							fellBackToRest: true,
							responseHeaders,
						})
						sseStream = trackResponsesTransportTelemetry(
							readSSEStream(resp, abortController),
							{
								transport: 'responses_http_fallback',
								phase: 'request',
								usedPreviousResponseId: false,
								fellBackToRest: true,
								responseHeaders,
							},
						)
					} catch (error) {
						if (!recordedFallbackFailure) {
							const errorTransportInfo = createResponsesTransportSummary({
								transport: 'responses_http_fallback',
								usedPreviousResponseId: false,
								fellBackToRest: true,
								errorKind: classifyResponsesTransportError(error),
							})
							recordResponsesTransportTelemetry({
								transport: 'responses_http_fallback',
								phase: 'request',
								success: false,
								durationMs: Date.now() - fallbackStartTime,
								usedPreviousResponseId: false,
								fellBackToRest: true,
								errorKind: errorTransportInfo.errorKind,
							})
							throw attachResponsesTransportErrorMetadata(error, {
								requestId: errorTransportInfo.requestId,
								transportInfo: errorTransportInfo,
							})
						}
						throw error
					}
				}
			} else {
				const url = `${config.baseURL}/responses`
				const headers = new Headers(options?.headers)
				headers.set('Content-Type', 'application/json')
				headers.set('Authorization', `Bearer ${apiKey}`)
				headers.set('Accept', 'text/event-stream')
				headers.set('x-client-request-id', sessionId)
				headers.set('session_id', sessionId)
				const restStartTime = Date.now()
				let recordedRestFailure = false
				try {
					debugLog(`[DEBUG_OPENAI] responsesClient HTTP: POST ${url}, inputItems=${request.input.length}, prevResponseId=${request.previous_response_id ?? 'none'}`)
					const resp = await fetch(url, {
						method: 'POST',
						headers,
						body: JSON.stringify(request),
						signal: abortController.signal,
					})
					debugLog(`[DEBUG_OPENAI] responsesClient HTTP: status=${resp.status}`)

					if (!resp.ok) {
						const transportHeaders = new Headers(resp.headers)
						const errorTransportInfo = createResponsesTransportSummary({
							transport: 'responses_http',
							usedPreviousResponseId,
							responseHeaders: transportHeaders,
							statusCode: resp.status,
							errorKind: 'http_status',
						})
						recordResponsesTransportTelemetry({
							transport: 'responses_http',
							phase: 'request',
							success: false,
							durationMs: Date.now() - restStartTime,
							usedPreviousResponseId,
							responseHeaders: transportHeaders,
							statusCode: resp.status,
							errorKind: 'http_status',
						})
						recordedRestFailure = true
						const body = await resp.text().catch(() => '')
						throw attachResponsesTransportErrorMetadata(
							new Error(`Responses API error ${resp.status}: ${body}`),
							{
								requestId: errorTransportInfo.requestId,
								responseHeaders: transportHeaders,
								transportInfo: errorTransportInfo,
							},
						)
					}

					responseHeaders = new Headers(resp.headers)
					transportInfo = createResponsesTransportSummary({
						transport: 'responses_http',
						usedPreviousResponseId,
						responseHeaders,
					})
					const rawSseStream = readSSEStream(resp, abortController)
					const trackedRawSseStream = canUsePreviousResponseId
						? trackResponsesContinuation(sessionId, fullRequest, rawSseStream)
						: rawSseStream
					sseStream = trackResponsesTransportTelemetry(trackedRawSseStream, {
						transport: 'responses_http',
						phase: 'request',
						usedPreviousResponseId,
						responseHeaders,
					})
				} catch (error) {
					if (!recordedRestFailure) {
						const errorTransportInfo = createResponsesTransportSummary({
							transport: 'responses_http',
							usedPreviousResponseId,
							errorKind: classifyResponsesTransportError(error),
						})
						recordResponsesTransportTelemetry({
							transport: 'responses_http',
							phase: 'request',
							success: false,
							durationMs: Date.now() - restStartTime,
							usedPreviousResponseId,
							errorKind: errorTransportInfo.errorKind,
						})
						throw attachResponsesTransportErrorMetadata(error, {
							requestId: errorTransportInfo.requestId,
							transportInfo: errorTransportInfo,
						})
					}
					throw error
				}
			}

			resolveResponseInfo({
				headers: responseHeaders,
				requestId: transportInfo?.requestId ?? null,
				transportInfo,
			})
			const gen = translateResponsesStream(sseStream, config.model, abortController)
			return new FakeStream(gen, abortController)
		} catch (error) {
			resolveResponseInfo({
				headers: new Headers(),
				requestId: null,
			})
			throw error
		}
	})()

	return makePromiseWithResponse(streamPromise, responseInfoPromise)
}
