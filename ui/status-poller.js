// Keep transport/JSON errors separate from rendering errors. A broken view does
// not mean the bot process stopped, and a missing view does not pause trading.
export async function refreshStatus({ fetcher = fetch, render, onConnectionError, onRenderError, timeoutMs = 10000 }) {
  let snapshot;
  try {
    const response = await fetcher('/api/status', { cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) {
      const error = new Error('Status HTTP failure'); error.httpStatus = response.status; throw error;
    }
    snapshot = await response.json();
  } catch (error) { onConnectionError(error); return 'CONNECTION_ERROR'; }
  try { render(snapshot); return 'OK'; }
  catch (error) { onRenderError(error); return 'RENDER_ERROR'; }
}
