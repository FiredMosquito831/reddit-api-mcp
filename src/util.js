// Reddit answers with JSON, but some endpoints return an empty body or plain text.
export function parseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
