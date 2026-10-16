import WebSocket from 'ws';

export const ACS_PATH = '/v2/state/active-contracts';
const LIST_LIMIT_CODE = 'JSON_API_MAXIMUM_LIST_ELEMENTS_NUMBER_REACHED';

export function isAcsListLimit(status: number, path: string, responseText: string): boolean {
  return status === 413 && path === ACS_PATH && responseText.includes(LIST_LIMIT_CODE);
}

export function activeContractsOverWebSocket(
  apiUrl: string,
  token: string | undefined,
  body: unknown,
  timeoutMs = 120_000,
): Promise<unknown[]> {
  const url = `${apiUrl.replace(/\/+$/, '').replace(/^http/i, 'ws')}${ACS_PATH}`;
  const protocols = token ? [`jwt.token.${token}`, 'daml.ws.auth'] : ['daml.ws.auth'];
  return new Promise((resolve, reject) => {
    const rows: unknown[] = [];
    let done = false;
    const ws = new WebSocket(url, protocols);
    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (err) {
        ws.terminate();
        reject(err);
      } else {
        resolve(rows);
      }
    };
    const timer = setTimeout(
      () => finish(new Error(`active-contracts stream timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    ws.on('open', () => ws.send(JSON.stringify(body)));
    ws.on('message', (data) => {
      let msg: unknown;
      try {
        msg = JSON.parse(String(data));
      } catch {
        finish(new Error('active-contracts stream sent a non-JSON frame'));
        return;
      }
      if (msg && typeof msg === 'object' && 'code' in msg && 'cause' in msg && !('contractEntry' in msg)) {
        const m = msg as { code: unknown; cause: unknown };
        finish(new Error(`active-contracts stream error ${String(m.code)}: ${String(m.cause).slice(0, 300)}`));
        return;
      }
      rows.push(msg);
    });
    ws.on('close', (code) => {
      if (code === 1000 || code === 1005) finish();
      else finish(new Error(`active-contracts stream closed with code ${code}`));
    });
    ws.on('error', (err) => finish(err));
  });
}
