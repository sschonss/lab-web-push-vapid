import { createPublicKey, verify } from 'node:crypto';

// Prefixo SPKI do algoritmo P-256. A chave pública VAPID que o web-push gera
// é o ponto não comprimido (65 bytes), e o JWT é assinado com esse par.
const P256_SPKI_PREFIX = Buffer.from(
  '3059301306072a8648ce3d020106082a8648ce3d030107034200',
  'hex',
);

export function maskSecret(value, head = 6, tail = 4) {
  if (typeof value !== 'string' || value.length <= head + tail + 1) return '…';
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

export function maskEndpoint(endpoint) {
  try {
    const url = new URL(endpoint);
    const parts = url.pathname.split('/');
    const last = parts.pop() ?? '';
    const maskedLast = last.length <= 8 ? '…' : `${last.slice(0, 4)}…${last.slice(-4)}`;
    return `${url.origin}${parts.join('/')}/${maskedLast}`;
  } catch {
    return '(endpoint inválido)';
  }
}

function verifyEs256(signingInput, signatureB64, publicKeyB64) {
  const raw = Buffer.from(publicKeyB64, 'base64url');
  if (raw.length !== 65) return false;
  const key = createPublicKey({
    key: Buffer.concat([P256_SPKI_PREFIX, raw]),
    format: 'der',
    type: 'spki',
  });
  const signature = Buffer.from(signatureB64, 'base64url');
  return verify(
    'sha256',
    Buffer.from(signingInput),
    { key, dsaEncoding: 'ieee-p1363' },
    signature,
  );
}

// Lê o header Authorization no formato da RFC 8292:
//   vapid t=<JWT>, k=<chave pública>
// O JWT não é cifrado. Dá para ler aud, exp e sub sem a chave privada.
// A assinatura é conferida com a chave pública que viajou no próprio header.
export function decodeVapidAuthorization(authorization) {
  if (typeof authorization !== 'string' || authorization.length === 0) {
    return null;
  }

  const match = authorization.match(
    /^vapid t=([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+),\s*k=([A-Za-z0-9_-]+)$/,
  );
  if (!match) {
    return { ok: false, error: 'Authorization não está no formato vapid t=…, k=…' };
  }

  const token = match[1];
  const publicKey = match[2];
  const [encodedHeader, encodedPayload, encodedSignature] = token.split('.');

  let header;
  let payload;
  try {
    header = JSON.parse(Buffer.from(encodedHeader, 'base64url').toString('utf8'));
    payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, error: 'JWT VAPID não pôde ser decodificado' };
  }

  let signatureValid = false;
  try {
    signatureValid = verifyEs256(
      `${encodedHeader}.${encodedPayload}`,
      encodedSignature,
      publicKey,
    );
  } catch {
    signatureValid = false;
  }

  return {
    ok: true,
    header,
    payload,
    signatureValid,
    token,
    publicKey,
  };
}
