// O web-push 3.6.7 manda o POST com https.request. Este módulo embrulha
// essa função para guardar, sem alterar o pedido, os bytes que saem do
// processo e a resposta que volta. É instrumentação do laboratório, não
// parte do protocolo.

function asBuffer(chunk, encoding) {
  if (chunk == null || typeof chunk === 'function') return null;
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  if (typeof chunk === 'string') {
    const enc = typeof encoding === 'string' ? encoding : 'utf8';
    return Buffer.from(chunk, enc);
  }
  return null;
}

export function installWireLog(https) {
  const completed = [];
  let context = null;
  const original = https.request;

  https.request = function patched(...args) {
    const options = args[0] && typeof args[0] === 'object' ? args[0] : {};
    const entry = {
      startedAt: new Date().toISOString(),
      hostname: options.hostname ?? null,
      port: options.port ?? null,
      method: options.method ?? 'GET',
      path: options.path ?? '/',
      plaintext: context?.plaintext ?? null,
      endpoint: context?.endpoint ?? null,
      headers: null,
      bodyBase64: '',
      response: null,
      error: null,
      logged: false,
    };

    const req = original.apply(this, args);
    const bodyChunks = [];
    const origWrite = req.write.bind(req);
    const origEnd = req.end.bind(req);

    req.write = function write(...writeArgs) {
      const buf = asBuffer(writeArgs[0], writeArgs[1]);
      if (buf) bodyChunks.push(buf);
      return origWrite(...writeArgs);
    };

    req.end = function end(...endArgs) {
      const buf = asBuffer(endArgs[0], endArgs[1]);
      if (buf) bodyChunks.push(buf);
      try {
        entry.headers = req.getHeaders();
      } catch {
        entry.headers = options.headers ?? null;
      }
      entry.bodyBase64 = Buffer.concat(bodyChunks).toString('base64');
      return origEnd(...endArgs);
    };

    const finish = () => {
      if (entry.logged) return;
      entry.logged = true;
      entry.completedAt = new Date().toISOString();
      completed.push(entry);
      if (completed.length > 50) completed.shift();
    };

    req.on('response', (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        entry.response = {
          statusCode: res.statusCode ?? 0,
          headers: res.headers,
          bodyBase64: body.toString('base64'),
          bodyText: body.toString('utf8'),
        };
        finish();
      });
    });

    req.on('error', (err) => {
      entry.error = err instanceof Error ? err.message : String(err);
      finish();
    });

    return req;
  };

  return {
    setContext(next) {
      context = next;
    },
    clearContext() {
      context = null;
    },
    count() {
      return completed.length;
    },
    all() {
      return completed;
    },
    clear() {
      completed.length = 0;
    },
    annotateLast(meta) {
      const entry = completed[completed.length - 1];
      if (!entry) return;
      Object.assign(entry, meta);
    },
  };
}
