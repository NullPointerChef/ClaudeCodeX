import { afterEach, expect, test } from 'bun:test'
import { resetStateForTests } from '../../../bootstrap/state.js'
import {
	_resetForTesting as resetAnalyticsForTesting,
	attachAnalyticsSink,
} from '../../analytics/index.js'
import { logAPIError, logAPISuccessAndDuration } from '../logging.js'

const ORIGINAL_MACRO = (globalThis as { MACRO?: Record<string, unknown> }).MACRO

afterEach(() => {
	resetAnalyticsForTesting()
	resetStateForTests()
	if (ORIGINAL_MACRO === undefined) {
		delete (globalThis as { MACRO?: Record<string, unknown> }).MACRO
	} else {
		;(globalThis as { MACRO?: Record<string, unknown> }).MACRO = ORIGINAL_MACRO
	}
})

;(globalThis as { MACRO?: Record<string, unknown> }).MACRO = {
	VERSION: 'test',
	BUILD_TIME: undefined,
}

test('logAPIError includes OpenAI Responses transport correlation fields', () => {
	const events: Array<{ eventName: string; metadata: Record<string, unknown> }> = []
	attachAnalyticsSink({
		logEvent(eventName, metadata) {
			events.push({
				eventName,
				metadata: metadata as Record<string, unknown>,
			})
		},
		logEventAsync: async () => {},
	})

	logAPIError({
		error: new Error('Responses API error 401'),
		model: 'gpt-5.3-codex',
		messageCount: 2,
		durationMs: 12,
		durationMsIncludingRetries: 12,
		attempt: 1,
		requestId: 'req_error_123',
		querySource: 'repl_main_thread',
		openAIResponsesTransport: {
			transport: 'responses_http_fallback',
			usedPreviousResponseId: false,
			fellBackToRest: true,
			requestId: 'req_error_123',
			hasCfRay: true,
			hasAuthError: true,
			hasAuthErrorCode: true,
			statusCode: 401,
			errorKind: 'http_status',
		},
	})

	const event = events.find(({ eventName }) => eventName === 'tengu_api_error')
	expect(event?.metadata.openaiResponsesTransport).toBe('responses_http_fallback')
	expect(event?.metadata.openaiResponsesUsedPreviousResponseId).toBe(false)
	expect(event?.metadata.openaiResponsesFellBackToRest).toBe(true)
	expect(event?.metadata.openaiResponsesHasCfRay).toBe(true)
	expect(event?.metadata.openaiResponsesHasAuthError).toBe(true)
	expect(event?.metadata.openaiResponsesHasAuthErrorCode).toBe(true)
	expect(event?.metadata.openaiResponsesTransportStatusCode).toBe(401)
	expect(event?.metadata.openaiResponsesTransportErrorKind).toBe('http_status')
})

test('logAPISuccessAndDuration includes OpenAI Responses transport correlation fields', () => {
	const events: Array<{ eventName: string; metadata: Record<string, unknown> }> = []
	attachAnalyticsSink({
		logEvent(eventName, metadata) {
			events.push({
				eventName,
				metadata: metadata as Record<string, unknown>,
			})
		},
		logEventAsync: async () => {},
	})

	logAPISuccessAndDuration({
		model: 'gpt-5.3-codex',
		preNormalizedModel: 'gpt-5.3-codex',
		start: Date.now() - 15,
		startIncludingRetries: Date.now() - 20,
		ttftMs: 5,
		usage: {
			input_tokens: 10,
			output_tokens: 4,
			cache_creation_input_tokens: 0,
			cache_read_input_tokens: 0,
		},
		attempt: 1,
		messageCount: 2,
		messageTokens: 14,
		requestId: 'req_success_123',
		stopReason: 'end_turn',
		didFallBackToNonStreaming: false,
		querySource: 'repl_main_thread',
		costUSD: 0,
		openAIResponsesTransport: {
			transport: 'responses_websocket',
			connectionReused: true,
			usedPreviousResponseId: true,
			fellBackToRest: false,
			requestId: 'req_success_123',
			hasCfRay: false,
			hasAuthError: false,
			hasAuthErrorCode: false,
		},
	})

	const event = events.find(({ eventName }) => eventName === 'tengu_api_success')
	expect(event?.metadata.openaiResponsesTransport).toBe('responses_websocket')
	expect(event?.metadata.openaiResponsesConnectionReused).toBe(true)
	expect(event?.metadata.openaiResponsesUsedPreviousResponseId).toBe(true)
	expect(event?.metadata.openaiResponsesFellBackToRest).toBe(false)
	expect(event?.metadata.openaiResponsesHasCfRay).toBe(false)
	expect(event?.metadata.openaiResponsesHasAuthError).toBe(false)
	expect(event?.metadata.openaiResponsesHasAuthErrorCode).toBe(false)
})
