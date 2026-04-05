import { afterEach, expect, test } from 'bun:test'
import {
  extractResponsesDebugInfo,
  recordResponsesStartupPrewarmTelemetry,
  recordResponsesTransportFallbackTelemetry,
  recordResponsesTransportTelemetry,
  setResponsesTelemetryHooksForTests,
} from '../responsesTelemetry.js'

afterEach(() => {
  setResponsesTelemetryHooksForTests(null)
})

test('extractResponsesDebugInfo reads request tracking headers and decodes auth error code', () => {
  const info = extractResponsesDebugInfo(
    new Headers({
      'x-oai-request-id': 'req-auth',
      'cf-ray': 'ray-auth',
      'x-openai-authorization-error': 'missing_authorization_header',
      'x-error-json': 'eyJlcnJvciI6eyJjb2RlIjoidG9rZW5fZXhwaXJlZCJ9fQ==',
    }),
  )

  expect(info).toEqual({
    requestId: 'req-auth',
    cfRay: 'ray-auth',
    authError: 'missing_authorization_header',
    authErrorCode: 'token_expired',
  })
})

test('recordResponsesTransportTelemetry emits analytics, diagnostics, and debug context', () => {
  const analytics: Array<{ name: string; metadata: Record<string, unknown> }> = []
  const diagnostics: Array<{
    level: string
    event: string
    data?: Record<string, unknown>
  }> = []
  const debug: string[] = []

  setResponsesTelemetryHooksForTests({
    logEvent: (name, metadata) => {
      analytics.push({ name, metadata })
    },
    logForDiagnosticsNoPII: (level, event, data) => {
      diagnostics.push({ level, event, data })
    },
    logForDebugging: message => {
      debug.push(message)
    },
  })

  recordResponsesTransportTelemetry({
    transport: 'responses_websocket',
    phase: 'request',
    success: true,
    durationMs: 123,
    connectionReused: true,
    usedPreviousResponseId: true,
    responseId: 'resp-1',
    responseHeaders: new Headers({
      'x-request-id': 'req-1',
      'cf-ray': 'ray-1',
    }),
  })

  expect(analytics).toHaveLength(1)
  expect(analytics[0]).toEqual({
    name: 'tengu_openai_responses_transport',
    metadata: {
      transport: 'responses_websocket',
      phase: 'request',
      success: true,
      durationMs: 123,
      connectionReused: true,
      usedPreviousResponseId: true,
      fellBackToRest: false,
      hasRequestId: true,
      hasCfRay: true,
      hasAuthError: false,
      hasAuthErrorCode: false,
    },
  })

  expect(diagnostics).toEqual([
    {
      level: 'info',
      event: 'openai_responses_transport_completed',
      data: {
        transport: 'responses_websocket',
        phase: 'request',
        duration_ms: 123,
        connection_reused: true,
        used_previous_response_id: true,
        fell_back_to_rest: false,
        response_id: 'resp-1',
        request_id: 'req-1',
        cf_ray: 'ray-1',
      },
    },
  ])

  expect(debug).toEqual([
    '[openai responses] transport=responses_websocket phase=request success=true duration_ms=123 connection_reused=true used_previous_response_id=true request_id=req-1 cf_ray=ray-1 response_id=resp-1',
  ])
})

test('prewarm cancellation and fallback telemetry use stable event names', () => {
  const analytics: Array<{ name: string; metadata: Record<string, unknown> }> = []
  const diagnostics: Array<{
    level: string
    event: string
    data?: Record<string, unknown>
  }> = []

  setResponsesTelemetryHooksForTests({
    logEvent: (name, metadata) => {
      analytics.push({ name, metadata })
    },
    logForDiagnosticsNoPII: (level, event, data) => {
      diagnostics.push({ level, event, data })
    },
    logForDebugging: () => {},
  })

  recordResponsesStartupPrewarmTelemetry({
    status: 'cancelled',
    reason: 'timeout',
    durationMs: 250,
  })
  recordResponsesTransportFallbackTelemetry({
    phase: 'request',
    reason: 'websocket_setup_failed',
  })

  expect(analytics).toEqual([
    {
      name: 'tengu_openai_responses_startup_prewarm',
      metadata: {
        status: 'cancelled',
        reason: 'timeout',
        durationMs: 250,
      },
    },
    {
      name: 'tengu_openai_responses_transport_fallback',
      metadata: {
        phase: 'request',
        reason: 'websocket_setup_failed',
      },
    },
  ])

  expect(diagnostics).toEqual([
    {
      level: 'warn',
      event: 'openai_responses_startup_prewarm_cancelled',
      data: {
        duration_ms: 250,
        reason: 'timeout',
      },
    },
    {
      level: 'warn',
      event: 'openai_responses_transport_fallback',
      data: {
        phase: 'request',
        reason: 'websocket_setup_failed',
      },
    },
  ])
})
