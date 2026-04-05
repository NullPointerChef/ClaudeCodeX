import type { ClientRequest, IncomingMessage } from 'http'
import type WsWebSocket from 'ws'
import { getWebSocketTLSOptions } from '../../../utils/mtls.js'
import { getWebSocketProxyAgent } from '../../../utils/proxy.js'

export interface ResponsesWebSocketConnection {
	responseHeaders: Headers
	send(payload: string): Promise<void>
	messages(): AsyncGenerator<string>
	close(code?: number): void
	isClosed(): boolean
}

type ResponsesWebSocketFactoryParams = {
	url: string
	headers: Record<string, string>
	signal?: AbortSignal
}

type ResponsesWebSocketFactory = (
	params: ResponsesWebSocketFactoryParams,
) => Promise<ResponsesWebSocketConnection>

let responsesWebSocketFactoryForTests: ResponsesWebSocketFactory | null = null

function toHeaders(source: IncomingMessage['headers']): Headers {
	const headers = new Headers()
	for (const [name, value] of Object.entries(source)) {
		if (Array.isArray(value)) {
			headers.set(name, value.join(', '))
		} else if (value !== undefined) {
			headers.set(name, value)
		}
	}
	return headers
}

export function setResponsesWebSocketFactoryForTests(
	factory: ResponsesWebSocketFactory | null,
): void {
	responsesWebSocketFactoryForTests = factory
}

export async function openResponsesWebSocket(
	params: ResponsesWebSocketFactoryParams,
): Promise<ResponsesWebSocketConnection> {
	if (responsesWebSocketFactoryForTests) {
		return responsesWebSocketFactoryForTests(params)
	}

	const { default: WebSocket } = await import('ws')

	return await new Promise<ResponsesWebSocketConnection>((resolve, reject) => {
		const queue: string[] = []
		let queueWaiter: (() => void) | null = null
		let queueError: Error | undefined
		let queueClosed = false
		let settled = false
		let responseHeaders = new Headers()
		let closedByClient = false
		let socketClosed = false

		const wakeQueue = () => {
			queueWaiter?.()
			queueWaiter = null
		}

		const closeQueue = (error?: Error) => {
			if (queueClosed) return
			queueClosed = true
			queueError = error
			wakeQueue()
		}

		const cleanup = (ws: WsWebSocket) => {
			ws.off('open', handleOpen)
			ws.off('message', handleMessage)
			ws.off('close', handleClose)
			ws.off('error', handleError)
			wsRequest?.off('upgrade', handleUpgrade)
			wsRequest?.off('response', handleResponse)
			params.signal?.removeEventListener('abort', handleAbort)
		}

		const handleAbort = () => {
			closedByClient = true
			if (
				ws.readyState === WebSocket.CONNECTING ||
				ws.readyState === WebSocket.OPEN
			) {
				ws.close()
			}
			closeQueue()
			if (!settled) {
				settled = true
				reject(new Error('Responses websocket request aborted'))
			}
		}

		const handleUpgrade = (response: IncomingMessage) => {
			responseHeaders = toHeaders(response.headers)
		}

		const handleOpen = () => {
			if (settled) return
			settled = true
			resolve({
				responseHeaders,
				send(payload: string) {
					return new Promise<void>((sendResolve, sendReject) => {
						ws.send(payload, error => {
							if (error) {
								sendReject(error)
								return
							}
							sendResolve()
						})
					})
				},
				async *messages() {
					while (!queueClosed || queue.length > 0) {
						if (queue.length === 0) {
							await new Promise<void>(resolveQueue => {
								queueWaiter = resolveQueue
							})
							continue
						}

						const message = queue.shift()
						if (message !== undefined) {
							yield message
						}
					}

					if (queueError) {
						throw queueError
					}
					},
				close(code?: number) {
					closedByClient = true
					closeQueue()
					if (
						ws.readyState === WebSocket.CONNECTING ||
						ws.readyState === WebSocket.OPEN
					) {
						ws.close(code)
					}
				},
				isClosed() {
					return socketClosed
				},
			})
		}

		const handleMessage = (
			data: Buffer | ArrayBuffer | Buffer[],
			isBinary: boolean,
		) => {
			if (queueClosed) return
			if (isBinary) return

			if (Array.isArray(data)) {
				queue.push(Buffer.concat(data).toString('utf-8'))
			} else if (data instanceof ArrayBuffer) {
				queue.push(Buffer.from(data).toString('utf-8'))
			} else {
				queue.push(data.toString('utf-8'))
			}
			wakeQueue()
		}

		const handleClose = (code: number, reason: Buffer) => {
			socketClosed = true
			cleanup(ws)
			const isNormalClose = code === 1000 || code === 1001 || closedByClient
			const error = isNormalClose
				? undefined
				: new Error(
						`Responses websocket closed unexpectedly: ${code} ${reason.toString('utf-8')}`,
					)
			closeQueue(error)

			if (!settled) {
				settled = true
				reject(error ?? new Error('Responses websocket closed before opening'))
			}
		}

		const handleError = (error: Error) => {
			if (!settled) {
				settled = true
				cleanup(ws)
				reject(error)
				return
			}

			closeQueue(error)
		}

		const handleResponse = (response: IncomingMessage) => {
			response.resume()
			const status = response.statusCode ?? 'unknown'
			const error = new Error(`Responses websocket upgrade failed: ${status}`)
			if (!settled) {
				settled = true
				cleanup(ws)
				reject(error)
				return
			}
			closeQueue(error)
		}

		const ws = new WebSocket(params.url, {
			headers: params.headers,
			agent: getWebSocketProxyAgent(params.url),
			...getWebSocketTLSOptions(),
		})
		const wsRequest = (ws as WsWebSocket & { _req?: ClientRequest })._req

		ws.on('open', handleOpen)
		ws.on('message', handleMessage)
		ws.on('close', handleClose)
		ws.on('error', handleError)
		wsRequest?.on('upgrade', handleUpgrade)
		wsRequest?.on('response', handleResponse)

		if (params.signal) {
			if (params.signal.aborted) {
				handleAbort()
			} else {
				params.signal.addEventListener('abort', handleAbort)
			}
		}
	})
}
