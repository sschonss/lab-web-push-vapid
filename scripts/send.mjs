import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const dataDir = path.resolve(root, process.env.DATA_DIR || 'data');
const infoPath = path.join(dataDir, 'server.json');
const tokenPath = path.join(dataDir, 'send-token');

if (!fs.existsSync(tokenPath) || !fs.existsSync(infoPath)) {
  console.error('Servidor ainda não foi iniciado. Rode `npm start` e deixe esse processo aberto.');
  process.exit(1);
}

const info = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
const token = fs.readFileSync(tokenPath, 'utf8').trim();
const title = process.argv[2] || 'Lab Web Push';
const body = process.argv[3] || 'A aba pode estar fechada. Esta mensagem saiu do servidor.';
const url = `http://${info.host}:${info.port}/send`;

const response = await fetch(url, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    authorization: `Bearer ${token}`,
  },
  body: JSON.stringify({ title, body, url: '/' }),
});

const text = await response.text();
console.log(text);
if (!response.ok) process.exit(1);
