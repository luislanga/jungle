export function isValidAmountFormat(value: unknown): value is string {
  // Accept digits with an optional decimal point and one or two decimal places.
  // Signs, scientific notation and additional decimal places are not valid input.
  return typeof value === 'string' && /^\d+(?:\.\d{1,2})?$/.test(value);
}

// Intl.supportedValuesOf reads currency codes such as BRL, USD and EUR from
// Bun's built-in internationalization data. It does not make a network request.
// Set stores those codes so .has() can check whether a currency is supported.
const SUPPORTED_CURRENCIES = new Set(Intl.supportedValuesOf('currency'));

export function isSupportedCurrency(value: unknown): value is string {
  return typeof value === 'string' && SUPPORTED_CURRENCIES.has(value);
}
