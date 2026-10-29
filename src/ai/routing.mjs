const validPrice = value => (typeof value === 'string' && value.trim() !== '' || typeof value === 'number') && Number.isFinite(Number(value)) && Number(value) >= 0;

/** Catalog prices are USD/token. Provider max_price uses USD/million tokens. */
export function normalizeModel(item, now = Date.now()) {
  if (!item || typeof item.id !== 'string' || !/^[\w./:+-]{1,200}$/.test(item.id) || /:batch(?:$|:)/i.test(item.id)) return null;
  const supported = Array.isArray(item.supported_parameters) ? item.supported_parameters : [];
  const jsonMode = supported.includes('structured_outputs') ? 'json_schema' : supported.includes('response_format') ? 'json_object' : null;
  if (!jsonMode) return null;
  if (!item.architecture?.input_modalities?.includes('text') || !item.architecture?.output_modalities?.includes('text')) return null;
  const expires = item.expiration_date;
  if (expires != null && (!Number.isFinite(Date.parse(expires)) || Date.parse(expires) <= now)) return null;
  if (!Number.isFinite(item.context_length) || item.context_length <= 0) return null;
  if (!['prompt', 'completion'].every(key => validPrice(item.pricing?.[key]))) return null;
  // `request` is optional in the live catalog. An omitted request charge is
  // bounded to zero again in provider.max_price.request, never guessed upward.
  if (item.pricing.request !== undefined && !validPrice(item.pricing.request)) return null;
  if (item.pricing.overrides && Object.keys(item.pricing.overrides).length) return null;
  if (item.pricing.internal_reasoning !== undefined && (!validPrice(item.pricing.internal_reasoning) || Number(item.pricing.internal_reasoning) > 0)) return null;
  const prompt = Number(item.pricing.prompt), completion = Number(item.pricing.completion), request = Number(item.pricing.request ?? 0);
  return {
    id: item.id, supported_parameters: supported, json_mode: jsonMode, context_length: item.context_length,
    max_completion_tokens: item.top_provider?.max_completion_tokens ?? null,
    prompt_usd_per_million: prompt * 1000000, completion_usd_per_million: completion * 1000000,
    request_usd: request, free: prompt === 0 && completion === 0 && request === 0,
    reasoning: item.reasoning && typeof item.reasoning === 'object' ? {
      mandatory: item.reasoning.mandatory === true,
      supports_max_tokens: item.reasoning.supports_max_tokens === true,
      supported_efforts: item.reasoning.supported_efforts === null ? null : Array.isArray(item.reasoning.supported_efforts) ? item.reasoning.supported_efforts.filter(value => ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(value)) : [],
    } : null,
  };
}

export function reasoningControl(model, outputTokens) {
  if (!model.reasoning && !model.supported_parameters.includes('reasoning')) return { suitable: true, extra_tokens: 0 };
  if (!model.reasoning?.mandatory) return { suitable: true, request: { enabled: false, exclude: true }, extra_tokens: 0 };
  const efforts = model.reasoning.supported_efforts;
  const effort = efforts === null ? 'minimal' : ['minimal', 'low'].find(value => efforts.includes(value));
  if (effort) return { suitable: true, request: { effort, exclude: true }, extra_tokens: Math.ceil(outputTokens * (effort === 'low' ? 0.2 : 0.1)) };
  if (model.reasoning.supports_max_tokens) {
    const limit = Math.max(1, Math.min(128, Math.floor(outputTokens / 5)));
    return { suitable: true, request: { max_tokens: limit, exclude: true }, extra_tokens: limit };
  }
  // Mandatory, uncapped reasoning is unsuitable for these bounded JSON tasks.
  return { suitable: false, extra_tokens: 0 };
}

export function estimateModelCost(model, inputTokens, outputTokens) {
  return inputTokens * model.prompt_usd_per_million / 1000000 + outputTokens * model.completion_usd_per_million / 1000000 + model.request_usd;
}

export function routingCandidates(models, { inputTokens, outputTokens, allowPaid, maxPromptUsdPerMillion, maxCompletionUsdPerMillion, requestBudgetUsd, model = 'auto' }) {
  const candidates = models.map(item => ({ ...item, reasoning_control: reasoningControl(item, outputTokens) }))
    .filter(item => (model === 'auto' || item.id === model)
    && item.reasoning_control.suitable
    && (allowPaid || item.free)
    && item.prompt_usd_per_million <= maxPromptUsdPerMillion
    && item.completion_usd_per_million <= maxCompletionUsdPerMillion
    && item.context_length >= inputTokens + outputTokens + item.reasoning_control.extra_tokens
    && (item.max_completion_tokens == null || item.max_completion_tokens >= outputTokens))
    .map(item => ({ ...item, estimated_cost_usd: estimateModelCost(item, inputTokens, outputTokens + item.reasoning_control.extra_tokens) }))
    .filter(item => item.estimated_cost_usd <= requestBudgetUsd);
  return candidates.sort((a, b) => Number(b.free) - Number(a.free) || a.estimated_cost_usd - b.estimated_cost_usd || a.id.localeCompare(b.id));
}
