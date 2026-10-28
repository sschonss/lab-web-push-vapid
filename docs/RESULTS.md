# O que este laboratório observou

Medido em **28 de outubro de 2026**. Nada abaixo foi inventado para preencher lacuna: onde um passo não aconteceu, isso está dito. Há duas execuções. Elas não compartilham chave VAPID nem ciphertext.

| | Execução A | Execução B |
| --- | --- | --- |
| Começo | 2026-10-28T22:15:09Z | 2026-10-28T22:19:04Z |
| Papel | Chrome de verdade contra o FCM, mais o 410 tardio do mesmo endpoint | Push service HTTPS local, e uma segunda tentativa no Chrome |
| Chaves | geradas na hora em `data/validate/`, fora do git | outro par, também fora do git |

Ambiente das duas: Node.js `v22.23.4`, `web-push` 3.6.7, Google Chrome `156.0.8078.47`, Linux `6.12.94+`. O Chrome abriu com janela (`headless: false`) no display `:1`, que já existia; o Xvfb não precisou subir. User agent medido: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36`.

O comando foi `npm run validate`. Ele sobe o servidor do lab, um push service HTTPS de mentira em `127.0.0.1:8799`, e o Chrome.

## Como ler

**De verdade** quer dizer: o Chrome criou a inscrição, o processo Node escreveu o HTTP, e a resposta voltou do host que está no endpoint. No caso do FCM, não temos o log interno da Google. Temos o que o cliente HTTPS enviou e o que o FCM respondeu. O service worker é quem leu o texto em claro.

**Simulado** quer dizer: um servidor HTTPS deste processo fez o papel de push service, ou uma função local fez o papel da chave privada do navegador. Isso está marcado em cada seção.

Os headers saem do Node com o nome em minúsculas (`authorization`, `content-encoding`, `ttl`, `urgency`). No HTTP o nome não distingue maiúsculas. Os valores são os que foram medidos.

Chave privada, chave pública completa, `auth`, `p256dh` e o token do endpoint não entram aqui. O endpoint aparece só com as pontas do token.

## 1. Janela anônima não inscreve (de verdade, e falhou)

Antes da execução A, o Playwright abriu o Chrome no contexto padrão, que é uma janela anônima. O clique em **Ativar notificações** não criou inscrição. A página mostrou:

```text
Registration failed - permission denied
```

O console do Chrome registrou:

```text
Chrome currently does not support the Push API in incognito mode (https://crbug.com/41124656). There is deliberately no way to feature-detect this, since incognito mode needs to be undetectable by websites.
```

A execução A em diante usa um perfil persistente, janela normal. `Notification.permission` ficou `granted`.

## 2. Inscrição no FCM (de verdade, execução A)

O Chrome, dirigido pelo Playwright, abriu `http://127.0.0.1:8787`, clicou em **Ativar notificações** e devolveu uma inscrição. A permissão foi `granted`.

- Origem do push service: `https://fcm.googleapis.com`
- Endpoint mascarado: `https://fcm.googleapis.com/fcm/send/dHcP…E3xQ`
- A página mediu `p256dh` com 65 bytes e `auth` com 16 bytes. Os valores não foram guardados neste arquivo.

Não houve endpoint da Mozilla nem da Apple. Firefox e Safari não estavam neste ambiente.

## 3. Envio com a página aberta (de verdade, execução A)

O botão **Disparar agora** pediu o `POST /send`. O FCM respondeu **201** em `Wed, 28 Oct 2026 22:16:54 GMT`. O service worker postou de volta o texto que leu, e a página mostrou esse texto.

Pedido que o cliente HTTPS escreveu para `fcm.googleapis.com`:

```text
POST /fcm/send/dHcP…E3xQ
host: fcm.googleapis.com
ttl: 3600
urgency: high
topic: lab
content-type: application/octet-stream
content-encoding: aes128gcm
content-length: 182
authorization: vapid t=eyJ0eXAiOiJK…Y1qM-A, k=BPTww8…HZro
```

JWT decodificado do `t=`. A assinatura ES256 foi conferida com a chave pública do próprio header `k=` e bateu. A chave tem 65 bytes e é a mesma que o servidor estava usando.

```json
{
  "header": { "typ": "JWT", "alg": "ES256" },
  "payload": {
    "aud": "https://fcm.googleapis.com",
    "exp": 1793269014,
    "sub": "mailto:webpush-lab@luizschons.com"
  }
}
```

`exp` 1793269014 é `2026-10-29T10:16:54Z`, doze horas depois do envio. Dentro do máximo de 24 horas da RFC 8292.

Resposta do FCM:

```text
HTTP 201
date: Wed, 28 Oct 2026 22:16:54 GMT
content-length: 0
content-type: text/html; charset=UTF-8
location: https://fcm.googleapis.com/0:1793225814618805%2fd9afcd0001a18d
```

O corpo da resposta tinha 0 bytes. A inscrição não foi apagada.

Texto em claro que o servidor pediu para cifrar, e que o service worker devolveu igual, caractere por caractere:

```text
{"title":"Lab Web Push","body":"Disparo com a página ainda aberta.","url":"/"}
```

Corpo cifrado, 182 bytes, SHA-256 `58bcb26b7a09fcfd0e7d93a2bbadd7945ee1ef4006cbb3bac981e77fb74e7d2a`. O texto em claro não aparece dentro desses bytes.

```text
up0IdDqUjddJJ6BRZBs3bgAAEABBBFVesIOZiJ6vLr15vPgvvmSHkXvqmQco4r67M4qgM4SSurodkhcr70npAmRwWkaUM9HC6UrQpoH55nqc7GVyzotRjWoYbOxVN7crivpwxM3iV6Zy/QYNraMgimithNCL0zYbDyVgbZxWsGh3IpUIJkN/QY12xdeVson3D28WDAqV60bqs6fSmZcp/+C1lql1vTIXj8Cqb2yEmeiOBEbFwR4=
```

## 4. Envio com a aba fechada (de verdade, execução A)

A aba foi fechada. `context.serviceWorkers().length` continuou 1. O processo do navegador ficou aberto. Aí o `POST /send` foi chamado de novo, sem página do site.

O FCM respondeu **201** em `Wed, 28 Oct 2026 22:17:03 GMT`.

```text
POST /fcm/send/dHcP…E3xQ
host: fcm.googleapis.com
ttl: 3600
urgency: high
topic: lab
content-type: application/octet-stream
content-encoding: aes128gcm
content-length: 176
authorization: vapid t=eyJ0eXAiOiJK…oCfqAQ, k=BPTww8…HZro
```

```json
{
  "header": { "typ": "JWT", "alg": "ES256" },
  "payload": {
    "aud": "https://fcm.googleapis.com",
    "exp": 1793269023,
    "sub": "mailto:webpush-lab@luizschons.com"
  },
  "signatureValid": true
}
```

`exp` 1793269023 é `2026-10-29T10:17:03Z`.

```text
HTTP 201
date: Wed, 28 Oct 2026 22:17:03 GMT
content-length: 0
location: https://fcm.googleapis.com/0:1793225823396825%2fd9afcd0001a18d
```

O service worker, sem aba aberta, fez `POST /lab/push-received` com este corpo, igual ao plaintext que o servidor cifrou:

```text
{"title":"Prova no Chrome","body":"Disparo com a aba fechada.","url":"/"}
```

Corpo que foi no fio, 176 bytes, SHA-256 `c1959683194ea3ff7b54763f9ec15a83fe6af993349962316d73dcd764ee70ba`. O plaintext não está dentro dele.

```text
aaYvT14ScYUdg5NnS5hpVAAAEABBBOsuQbkA1Aca2E5b8+IgCP61nW7wBgkMkElnqT5YMhM3Zb4UNOUgY/KhUMSM3l3kl+LNVjY13SyWHq2tNtxiKMeiIrfZTtftPVfLi95S3rD5P6mvOefCQZAfqkv8e3tS8LVBPaXfbeVGzBqOnNMyFeiDELopInL+6qjwyz/xxXHGA0rIbKU8S8ItO5DzSxgvGykHYbXvhR0vxMo=
```

`registration.getNotifications()`, chamado no service worker depois disso, devolveu uma notificação:

```json
{ "title": "Prova no Chrome", "body": "Disparo com a aba fechada.", "tag": "lab-web-push" }
```

Isso é o Chrome registrando a notificação. Não é um print do sistema operacional.

## 5. O 410 do FCM, e a limpeza (de verdade, execução A)

O teste reabriu a página e clicou em **Parar no navegador**. Isso chama `subscription.unsubscribe()` e não apaga a cópia do servidor.

O envio seguinte, ainda em `Wed, 28 Oct 2026 22:17:04 GMT`, **não** levou 410. O FCM respondeu de novo **201**, corpo vazio, `location: https://fcm.googleapis.com/0:1793225824670031%2fd9afcd0001a18d`. O servidor manteve a inscrição. JWT `aud` `https://fcm.googleapis.com`, `exp` 1793269024 (`2026-10-29T10:17:04Z`), `sub` `mailto:webpush-lab@luizschons.com`, assinatura válida. Header `authorization: vapid t=eyJ0eXAiOiJK…-Rv_RA, k=BPTww8…HZro`.

Cerca de um minuto depois, com o Chrome já fechado, o mesmo endpoint foi usado outra vez (`npm run send` contra o `data/validate` da execução A). Aí o FCM respondeu **410** em `Wed, 28 Oct 2026 22:18:06 GMT`:

```text
HTTP 410
date: Wed, 28 Oct 2026 22:18:06 GMT
content-type: text/plain; charset=utf-8
content-length: 47

push subscription has unsubscribed or expired.
```

O pedido desse 410 levava `content-encoding: aes128gcm`, `ttl: 3600`, `urgency: high`, `topic: lab`, `content-length: 206`, `authorization: vapid t=eyJ0eXAiOiJK…8JR2YQ, k=BPTww8…HZro`. O JWT tinha `aud` `https://fcm.googleapis.com`, `exp` 1793269086 (`2026-10-29T10:18:06Z`), `sub` `mailto:webpush-lab@luizschons.com`, assinatura válida.

A resposta do lab foi `removed: 1`. A lista de inscrições ficou com 0 itens. O servidor apagou o registro por causa do 410, como o código faz para 404 e para 410.

Não observamos 404 nesta sessão. O código trata os dois do mesmo jeito; o status que voltou foi 410.

## 6. Push service simulado (execução B)

Isto **não** é o FCM. É um HTTPS em `127.0.0.1:8799` com certificado gerado na hora. O `web-push` manda sempre por `https.request`, então o mock precisa ser HTTPS. O servidor do lab só aceita esse certificado inválido quando `LAB_ALLOW_INSECURE_LOCAL_PUSH=1`, e só para `127.0.0.1` ou `localhost`. O `npm start` normal não liga isso.

O processo do mock leu o pedido cru, depois de o TLS terminar. Os bytes batem com o que o log do cliente guardou (`serverSawSameBody: true`).

```text
POST /push/6c12…cf68
host: 127.0.0.1:8799
connection: close
ttl: 3600
urgency: high
topic: lab
content-type: application/octet-stream
content-encoding: aes128gcm
content-length: 202
authorization: vapid t=eyJ0eXAiOiJK…Oi6MMA, k=BIH69M…_Agk
```

```json
{
  "header": { "typ": "JWT", "alg": "ES256" },
  "payload": {
    "aud": "https://127.0.0.1:8799",
    "exp": 1793269145,
    "sub": "mailto:webpush-lab@luizschons.com"
  },
  "signatureValid": true
}
```

`exp` 1793269145 é `2026-10-29T10:19:05Z`. O `aud` é a origem do endpoint, com a porta, que é o que a biblioteca monta.

O mock respondeu **201** com corpo vazio. Um segundo `POST /send` para a mesma inscrição foi respondido **410** com corpo `Gone`. O lab devolveu `removed: true` e a inscrição não estava mais no arquivo.

Plaintext:

```text
{"title":"Prova local","body":"O push service simulado vê só o ciphertext.","url":"/prova-local"}
```

Ciphertext que o mock leu, 202 bytes, SHA-256 `8f6233c4392c212675cbe5bcb11b7b9c1457f8bd0501221a6b7fccf508a502c1`:

```text
cR4wenpIXo1mm5pk3rF2kQAAEABBBAFPqiV0VXoLIFT3LSObVnxY1IJ0sCjDJFB6eAGzFPHb4LzXgEmzXUR+YnwgZGGcse71xyKKHZj8+Rz+LUGx+lCJuMe7njDwko9gmVOAqzRPBYQ7y7h6RpIANU0iryr7IwFaNc1mcKxSMl+I2lCxLcEZmdASu+ObQif9RZcqNOeMWbqhB3JssWJ16NnJdNiZHYA1aWUXd9j8due4ZagOhBEPaeh9zOTZcyWd3PCxHcjhlXyAsg==
```

O plaintext não ocorre dentro do ciphertext.

A decifração dessa mensagem **não** foi feita pelo service worker. O teste gerou o par `p256dh`/`auth` e guardou a chave privada correspondente. Com ela, `http_ece` (a mesma biblioteca que o `web-push` usa para cifrar) devolveu o plaintext acima, igual. Isso mostra que o corpo é `aes128gcm` de verdade e que quem tem a chave privada do assinante lê o texto. No caminho do FCM, quem tem essa chave é o Chrome, e a leitura observada é a da seção 4.

## 7. Segunda tentativa no Chrome (de verdade, e incompleta)

Na execução B o Chrome inscreveu de novo. Endpoint mascarado: `https://fcm.googleapis.com/fcm/send/fuQA…T_Qw`. A página de novo mostrou 65 bytes e 16 bytes.

O primeiro envio, com a página ainda aberta, recebeu **410** na hora, com o mesmo texto do FCM:

```text
push subscription has unsubscribed or expired.
```

O service worker não recebeu payload. O servidor apagou a inscrição. O processo do Chrome fechou sozinho antes do passo de `unsubscribe` (`Target page, context or browser has been closed`). Não há, nesta execução, um 201 nem uma leitura do service worker.

Não sei por que o FCM recusou esta inscrição nova e aceitou a da execução A. Não vou inventar a causa. O fato serve como limite: um 201 não é garantido em toda tentativa a partir desta rede.

A captura `docs/pagina-inscrita.png` é desta execução, já com o layout atual. Dá para ver o endpoint mascarado, o 410, o `Content-Encoding: aes128gcm`, o `TTL: 3600`, o `Urgency: high` e os claims do JWT.

A captura `docs/pagina-entrega.png` é da execução A, no momento em que o FCM tinha respondido 201 e o service worker tinha mostrado o plaintext na página. A lista de campos da inscrição estava em duas colunas; depois da captura ela passou a ser uma linha por campo. O resto da página é o mesmo.

## 8. O que não foi testado

- **Clique na notificação.** `xdotool` não achou janela com o título "Prova no Chrome". `clicks` no servidor ficou 0. Nenhuma aba foi aberta pelo clique. O handler `notificationclick` está no `sw.js` e não foi exercido por um clique real. Não simulei o evento.
- **Notificação visível do sistema.** Neste display não apareceu um popup do SO. O que existe é o registro interno do Chrome, lido com `getNotifications()` na seção 4.
- **iPhone, iPad e Safari.** Não havia aparelho. Não há endpoint `web.push.apple.com`. O manifesto PWA está no lab porque o Web Push da Apple pede app na Tela de Início desde o iOS 16.4; isso não foi verificado aqui.
- **Firefox.** O binário não está nesta máquina. Não há endpoint da Mozilla.
- **`pushsubscriptionchange`.** O service worker escuta o evento. A execução A não gravou essa lista no relatório, então não dá para afirmar que o evento disparou ou deixou de disparar. A limpeza que funcionou foi a do 410, não a desse evento.
- **Entrega com o navegador completamente fechado**, processo e janela. Na seção 4 a aba do site estava fechada e o processo do Chrome seguia aberto. Não fechei o Chrome antes do envio.

## 9. Surpresas

- O Chrome 156 recusa push em janela anônima e não oferece um jeito da página detectar isso antes. O erro que a página vê é `Registration failed - permission denied`.
- Cancelar a inscrição no navegador não torna o endpoint inválido no mesmo segundo. O FCM ainda respondeu 201 às 22:17:04 e só respondeu 410 às 22:18:06, com a frase `push subscription has unsubscribed or expired.`
- Uma inscrição nova, na execução B, levou 410 no primeiro envio. A execução A, minutos antes, levou 201 e o service worker leu o plaintext.
- O `aud` do JWT não é fixo. Para o FCM foi `https://fcm.googleapis.com`. Para o mock, `https://127.0.0.1:8799`, porta inclusa.
- O corpo cifrado não contém o JSON. Isso foi conferido nos três envios ao FCM da execução A e no envio ao mock.
