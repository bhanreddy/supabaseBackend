/** Search terms and selected student identities need not appear in HTTP logs. */
export function redactAnalyticsUrl(value) {
  const url = String(value || '');
  return /\/results\/(?:exam-intelligence|exam-analytics)(?:[/?]|$)/i.test(url) ? url.split('?')[0] : url;
}
