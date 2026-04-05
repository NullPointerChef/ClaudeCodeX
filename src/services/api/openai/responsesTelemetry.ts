import { logEvent } from '../../analytics/index.js'
import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../../analytics/metadata.js'
import { logForDebugging, type DebugLogLevel } from '../../../utils/debug.js'
import { logForDiagnosticsNoPII } from '../../../utils/diagLogs.js'

const REQUEST_ID_HEADER = 'x-request-id'
const OAI_REQUEST_ID_HEADER = 'x-oai-request-id'
const CF_RAY_HEADER = 'cf-ray'
const AUTH_ERROR_HEADER = 'x-openai-authorization-error'
const X_ERROR_JSON_HEADER = 'x-error-json'

export type ResponsesTransportName =
  | 'responses_websocket'
  | 'responses_http'
  | 'responses_http_fallback'

export type ResponsesTelemetryPhase = 'request' | 'startup_prewarm'

export type ResponsesFallbackReason = 'websocket_setup_failed'

export type ResponsesStartupPrewarmStatus = 'completed' | 'failed' | 'cancelled'

export type ResponsesStartupPrewarmReason =
  | 'setup_failed'
  | 'stream_failed'
  | 'timeout'
  | 'superseded'

const RESPONSES_TRANSPORT_ERROR_METADATA = Symbol(
  'responsesTransportErrorMetadata',
)

type ResponsesTelemetryHooks = {
  logEvent: typeof logEvent
  logForDiagnosticsNoPII: typeof logForDiagnosticsNoPII
  logForDebugging: (message: string, options?: { level: DebugLogLevel }) => void
}

const defaultHooks: ResponsesTelemetryHooks = {
  logEvent,
  logForDiagnosticsNoPII,
  logForDebugging,
}

let telemetryHooksForTests: Partial<ResponsesTelemetryHooks> | null = null

function getTelemetryHooks(): ResponsesTelemetryHooks {
  return telemetryHooksForTests
    ? { ...defaultHooks, ...telemetryHooksForTests }
    : defaultHooks
}

export function setResponsesTelemetryHooksForTests(
  hooks: Partial<ResponsesTelemetryHooks> | null,
): void {
  telemetryHooksForTests = hooks
}

export interface ResponsesDebugInfo {
  requestId?: string
  cfRay?: string
  authError?: string
  authErrorCode?: string
}

export interface ResponsesTransportSummary {
  transport: ResponsesTransportName
  connectionReused?: boolean
  usedPreviousResponseId: boolean
  fellBackToRest: boolean
  requestId?: string
  hasCfRay: boolean
  hasAuthError: boolean
  hasAuthErrorCode: boolean
  statusCode?: number
  errorKind?: string
}

export interface ResponsesTransportErrorMetadata {
  requestId?: string
  responseHeaders?: Headers
  transportInfo?: ResponsesTransportSummary
}

type ErrorWithResponsesTransportMetadata = Error & {
  [RESPONSES_TRANSPORT_ERROR_METADATA]?: ResponsesTransportErrorMetadata
}

export function extractResponsesDebugInfo(
  headers?: Headers,
): ResponsesDebugInfo {
  if (!headers) {
    return {}
  }

  const requestId =
    headers.get(REQUEST_ID_HEADER) ?? headers.get(OAI_REQUEST_ID_HEADER) ?? undefined
  const cfRay = headers.get(CF_RAY_HEADER) ?? undefined
  const authError = headers.get(AUTH_ERROR_HEADER) ?? undefined

  let authErrorCode: string | undefined
  const encodedError = headers.get(X_ERROR_JSON_HEADER)
  if (encodedError) {
    try {
      const decoded = Buffer.from(encodedError, 'base64').toString('utf-8')
      const parsed = JSON.parse(decoded) as {
        error?: { code?: unknown }
      }
      if (typeof parsed.error?.code === 'string') {
        authErrorCode = parsed.error.code
      }
    } catch {
      // Ignore malformed auth error context headers.
    }
  }

  return {
    requestId,
    cfRay,
    authError,
    authErrorCode,
  }
}

export function createResponsesTransportSummary({
  transport,
  connectionReused,
  usedPreviousResponseId,
  fellBackToRest = false,
  responseHeaders,
  statusCode,
  errorKind,
}: {
  transport: ResponsesTransportName
  connectionReused?: boolean
  usedPreviousResponseId: boolean
  fellBackToRest?: boolean
  responseHeaders?: Headers
  statusCode?: number
  errorKind?: string
}): ResponsesTransportSummary {
  const debugInfo = extractResponsesDebugInfo(responseHeaders)

  return {
    transport,
    connectionReused,
    usedPreviousResponseId,
    fellBackToRest,
    requestId: debugInfo.requestId,
    hasCfRay: debugInfo.cfRay !== undefined,
    hasAuthError: debugInfo.authError !== undefined,
    hasAuthErrorCode: debugInfo.authErrorCode !== undefined,
    statusCode,
    errorKind,
  }
}

export function attachResponsesTransportErrorMetadata<T>(
  error: T,
  metadata: ResponsesTransportErrorMetadata,
): T {
  if (error instanceof Error) {
    ;(error as ErrorWithResponsesTransportMetadata)[
      RESPONSES_TRANSPORT_ERROR_METADATA
    ] = metadata
  }
  return error
}

export function getResponsesTransportErrorMetadata(
  error: unknown,
): ResponsesTransportErrorMetadata | undefined {
  return error instanceof Error
    ? (error as ErrorWithResponsesTransportMetadata)[
        RESPONSES_TRANSPORT_ERROR_METADATA
      ]
    : undefined
}

export function recordResponsesTransportTelemetry({
  transport,
  phase,
  success,
  durationMs,
  connectionReused,
  usedPreviousResponseId,
  fellBackToRest = false,
  responseHeaders,
  responseId,
  statusCode,
  errorKind,
}: {
  transport: ResponsesTransportName
  phase: ResponsesTelemetryPhase
  success: boolean
  durationMs: number
  connectionReused?: boolean
  usedPreviousResponseId: boolean
  fellBackToRest?: boolean
  responseHeaders?: Headers
  responseId?: string
  statusCode?: number
  errorKind?: string
}): void {
  const hooks = getTelemetryHooks()
  const debugInfo = extractResponsesDebugInfo(responseHeaders)
  const transportSummary = createResponsesTransportSummary({
    transport,
    connectionReused,
    usedPreviousResponseId,
    fellBackToRest,
    responseHeaders,
    statusCode,
    errorKind,
  })

  hooks.logEvent('tengu_openai_responses_transport', {
    transport:
      transport as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    phase:
      phase as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    success,
    durationMs,
    connectionReused,
    usedPreviousResponseId,
    fellBackToRest,
    ...(statusCode !== undefined ? { statusCode } : {}),
    ...(errorKind
      ? {
          errorKind:
            errorKind as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        }
      : {}),
    hasRequestId: transportSummary.requestId !== undefined,
    hasCfRay: transportSummary.hasCfRay,
    hasAuthError: transportSummary.hasAuthError,
    hasAuthErrorCode: transportSummary.hasAuthErrorCode,
  })

  const diagnosticLevel: 'info' | 'error' = success ? 'info' : 'error'
  hooks.logForDiagnosticsNoPII(
    diagnosticLevel,
    success
      ? 'openai_responses_transport_completed'
      : 'openai_responses_transport_failed',
    {
      transport,
      phase,
      duration_ms: durationMs,
      ...(connectionReused !== undefined
        ? { connection_reused: connectionReused }
        : {}),
      used_previous_response_id: usedPreviousResponseId,
      fell_back_to_rest: fellBackToRest,
      ...(statusCode !== undefined ? { status_code: statusCode } : {}),
      ...(errorKind ? { error_kind: errorKind } : {}),
      ...(responseId ? { response_id: responseId } : {}),
      ...(debugInfo.requestId ? { request_id: debugInfo.requestId } : {}),
      ...(debugInfo.cfRay ? { cf_ray: debugInfo.cfRay } : {}),
      ...(debugInfo.authError ? { auth_error: debugInfo.authError } : {}),
      ...(debugInfo.authErrorCode
        ? { auth_error_code: debugInfo.authErrorCode }
        : {}),
    },
  )

  if (
    transportSummary.requestId ||
    transportSummary.hasCfRay ||
    transportSummary.hasAuthError ||
    transportSummary.hasAuthErrorCode ||
    !success ||
    fellBackToRest
  ) {
    const parts = [
      `[openai responses] transport=${transport}`,
      `phase=${phase}`,
      `success=${success}`,
      `duration_ms=${durationMs}`,
      ...(connectionReused !== undefined
        ? [`connection_reused=${connectionReused}`]
        : []),
      `used_previous_response_id=${usedPreviousResponseId}`,
      ...(statusCode !== undefined ? [`status=${statusCode}`] : []),
      ...(errorKind ? [`error_kind=${errorKind}`] : []),
      ...(debugInfo.requestId ? [`request_id=${debugInfo.requestId}`] : []),
      ...(debugInfo.cfRay ? [`cf_ray=${debugInfo.cfRay}`] : []),
      ...(debugInfo.authError ? [`auth_error=${debugInfo.authError}`] : []),
      ...(debugInfo.authErrorCode
        ? [`auth_error_code=${debugInfo.authErrorCode}`]
        : []),
      ...(responseId ? [`response_id=${responseId}`] : []),
    ]

    hooks.logForDebugging(parts.join(' '), {
      level: success ? 'debug' : 'warn',
    })
  }
}

export function recordResponsesTransportFallbackTelemetry({
  phase,
  reason,
}: {
  phase: ResponsesTelemetryPhase
  reason: ResponsesFallbackReason
}): void {
  const hooks = getTelemetryHooks()
  hooks.logEvent('tengu_openai_responses_transport_fallback', {
    phase:
      phase as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    reason:
      reason as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })
  hooks.logForDiagnosticsNoPII('warn', 'openai_responses_transport_fallback', {
    phase,
    reason,
  })
  hooks.logForDebugging(
    `[openai responses] fallback_to_rest phase=${phase} reason=${reason}`,
    { level: 'warn' },
  )
}

export function recordResponsesStartupPrewarmTelemetry({
  status,
  reason,
  durationMs,
}: {
  status: ResponsesStartupPrewarmStatus
  reason?: ResponsesStartupPrewarmReason
  durationMs?: number
}): void {
  const hooks = getTelemetryHooks()
  hooks.logEvent('tengu_openai_responses_startup_prewarm', {
    status:
      status as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    ...(reason
      ? {
          reason:
            reason as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        }
      : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  })

  const level: 'info' | 'warn' | 'error' =
    status === 'completed' ? 'info' : status === 'cancelled' ? 'warn' : 'error'
  hooks.logForDiagnosticsNoPII(
    level,
    `openai_responses_startup_prewarm_${status}`,
    {
      ...(durationMs !== undefined ? { duration_ms: durationMs } : {}),
      ...(reason ? { reason } : {}),
    },
  )

  if (status !== 'completed') {
    const suffix = [
      ...(durationMs !== undefined ? [`duration_ms=${durationMs}`] : []),
      ...(reason ? [`reason=${reason}`] : []),
    ].join(' ')
    hooks.logForDebugging(
      `[openai responses] startup_prewarm status=${status}${suffix ? ` ${suffix}` : ''}`,
      { level: status === 'failed' ? 'warn' : 'debug' },
    )
  }
}
