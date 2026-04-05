import { getOpenAICompatConfig } from '../services/api/openai/providerConfig.js'
import { scheduleResponsesStartupWebSocketPrewarm } from '../services/api/openai/responsesClient.js'

let fired = false

export function scheduleOpenAIResponsesStartupPrewarm(): void {
  if (fired) return
  fired = true

  const config = getOpenAICompatConfig()
  if (
    !config ||
    config.providerName !== 'openai' ||
    config.useResponsesApi !== true
  ) {
    return
  }

  void scheduleResponsesStartupWebSocketPrewarm(config)
}
