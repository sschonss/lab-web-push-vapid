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

## 8. O que não foi testado em 28 de outubro

A lista abaixo é o que faltou naquele dia. O clique na notificação, a notificação desenhada pelo sistema e o envio com o processo do Chrome encerrado foram medidos em 29 de outubro, na seção 10. iPhone, Firefox e `pushsubscriptionchange` continuam sem prova.

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

## 10. PWA, 29 de outubro de 2026

Comando: `npm run validate:pwa`. Ele sobe o lab em `http://127.0.0.1:8788`, um barramento D-Bus só desta prova e o dunst 1.9.2 nesse barramento, e abre o Chrome 156 com janela no display `:1` (o mesmo que já existia; o Xvfb não precisou subir). Perfil persistente, não anônimo. O relatório redigido ficou em `data/validate-pwa/`, fora do git. Chaves geradas na hora, também fora do git.

Há duas execuções deste dia que entram aqui. Elas não compartilham chave VAPID.

| | Aba, sem instalar | Aplicativo instalado |
| --- | --- | --- |
| Começo | 2026-10-29T02:22:35Z | 2026-10-29T02:29:21Z |
| Chave pública no JWT | `BJykU9…hxjQ` | `BG8kU5…YSBg` |
| Papel | `beforeinstallprompt` e push com a página numa aba | instalação aceita no diálogo e push com a janela standalone |

User agent das duas: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36`.

Uma terceira passada, às 02:26, clicou o botão azul do diálogo. Esse botão era **Cancel**. A instalação não aconteceu. Não uso os números dela.

O dunst recebeu, antes do Chrome, uma notificação sintética só para ver se desenharia no display. Isso não é Web Push e não entra nos status abaixo.

### 10.1 O Chrome ofereceu a instalação (de verdade)

Nas duas execuções o Chrome buscou `http://127.0.0.1:8788/manifest.webmanifest` sem erro de parse, `Page.getInstallabilityErrors` voltou lista vazia, e a página mostrou o botão **Instalar aplicativo** com o texto “O Chrome ofereceu a instalação (beforeinstallprompt).” A captura é `docs/pwa-oferta-instalacao.png`.

Na execução das 02:22 a janela do Chrome estava na aba `about:blank`. O diálogo de instalar não estava na tela. `PWA.install` pelo CDP falhou com `kCancelledDueToMainFrameNavigation`. `chrome://apps` mostrou a página vazia, “Web apps that you install appear here”. Não houve instalação.

Na execução das 02:29 a janela se chamava `Lab: Web Push com VAPID - Google Chrome`. O `prompt()` abriu o diálogo nativo “Install app”, com Cancel e Install, o nome “Lab Web Push com VAPID” e a origem `127.0.0.1:8788`. A captura, tirada antes do clique, é `docs/pwa-dialogo-instalar.png`.

O foco inicial desse diálogo é o Cancel, que é o botão azul. Um Return nesse estado recusa. O clique que valeu foi no botão da direita, em `740,279`, feito com `xdotool`. A página de origem passou a dizer que a instalação foi aceita. Não usei `--app=` na linha de comando.

O Chrome guardou o aplicativo no perfil, em `Default/Web Applications/Manifest Resources/`, com ícones 192 e 512 e a versão maskable. `PWA.launch` abriu uma janela sem barra de endereço, título “Lab Web Push com VAPID”, cor de tema verde. Dentro dela, `matchMedia('(display-mode: standalone)')` era verdadeiro. A captura é `docs/pwa-instalada.png`.

Essa captura ainda mostra a frase “O Chrome ainda não ofereceu a instalação.” Ela é o texto inicial do documento novo: a janela do aplicativo não recebe `beforeinstallprompt` de novo, porque o site já está instalado. A linha de cima, “Modo de exibição: standalone”, e a ausência da barra de endereço são a prova. O código, depois dessa captura, passou a trocar essa frase quando o modo já é standalone. A imagem não tem essa frase nova.

### 10.2 Inscrição (de verdade)

Permissão `granted`. A página mediu `p256dh` com 65 bytes e `auth` com 16 bytes. A inscrição que o FCM aceitou nos envios seguintes está mascarada como `https://fcm.googleapis.com/fcm/send/d_5p…AnPj`.

A primeira inscrição da mesma execução, `https://fcm.googleapis.com/fcm/send/e-MO…qQ_v`, foi recusada. O FCM respondeu **410** em `Thu, 29 Oct 2026 02:29:31 GMT` e de novo em `Thu, 29 Oct 2026 02:29:35 GMT`, com o corpo:

```text
push subscription has unsubscribed or expired.
```

O lab apagou o registro (`removed: true`). O service worker não leu payload nenhum desses dois envios. O aplicativo estava em primeiro plano, em `standalone`, e mesmo assim não houve notificação. Não vou explicar por que o FCM recusou uma inscrição nova: a execução B de 28 de outubro já tinha feito isso, e eu continuo sem a causa.

### 10.3 Primeiro plano

**Aplicativo instalado: testado, e o push não chegou.** Os dois envios com a janela standalone em primeiro plano são os 410 da seção 10.2. O dunst não mostrou notificação. `busHasBody` ficou falso.

O pedido do 410 das 02:29:35, para `e-MO…qQ_v`:

```text
POST /fcm/send/e-MO…qQ_v
host: fcm.googleapis.com
ttl: 3600
urgency: high
topic: lab
content-type: application/octet-stream
content-encoding: aes128gcm
content-length: 202
authorization: vapid t=eyJ0eXAiOiJK…0ak5lg, k=BG8kU5…YSBg
```

```json
{
  "header": { "typ": "JWT", "alg": "ES256" },
  "payload": {
    "aud": "https://fcm.googleapis.com",
    "exp": 1793284175,
    "sub": "mailto:webpush-lab@luizschons.com"
  },
  "signatureValid": true
}
```

`exp` 1793284175 é `2026-10-29T14:29:35Z`, doze horas depois. Corpo cifrado, 202 bytes, SHA-256 `806211972af0613de67f749f0ffe7ce1a12fa3c104d4fe322199fb5e7b2318e4`. O plaintext não está dentro dele.

```text
xtCSxLMXp27LSX16N2SEiAAAEABBBPwV83IN5eQpHsDqktLHiP3aCnByCO+ae52W/6uxE9gCDtjpsKHEZcbGtl3buxZABsnG4NwlAMyF/LvXypvdfoHWscwOoaY46xQMpbxkl/PrMs6FFNAEVhnsu9j796g0J5dajHAwtvAJehNj9D3A10y3IkzGJAtdOtjoLDSoIpZEWJWg4B6nwwj/9Ra5s2VYR/EuRs3iui//d3t+UvefpbfZfg9vqXZ+6izFnKjyy63cTttuCQ==
```

Plaintext que o servidor cifrou e que ninguém no Chrome leu:

```text
{"title":"PWA em primeiro plano","body":"O aplicativo está aberto e em primeiro plano.","url":"/"}
```

**Aba comum, na execução das 02:22: chegou de verdade, e não era o aplicativo instalado.** A página estava em `display-mode: browser`. O FCM respondeu **201** em `Thu, 29 Oct 2026 02:22:59 GMT`. O service worker devolveu o mesmo JSON. O dunst desenhou a notificação. A captura é `docs/pwa-notificacao-primeiro-plano.png`.

```text
POST /fcm/send/e6M4…0bs_
host: fcm.googleapis.com
ttl: 3600
urgency: high
topic: lab
content-encoding: aes128gcm
content-length: 202
authorization: vapid t=eyJ0eXAiOiJK…AYXtyA, k=BJykU9…hxjQ
```

JWT `aud` `https://fcm.googleapis.com`, `exp` 1793283779 (`2026-10-29T14:22:59Z`), `sub` `mailto:webpush-lab@luizschons.com`, assinatura válida. `location: https://fcm.googleapis.com/0:1793240579304168%2fd9afcd0001a18d`. SHA-256 `fbe921086a4592a10485f7521c2ed1bebcd9579822df56fef47497675aa39b41`. O plaintext não está no ciphertext.

```text
FmIM6rH9ya4vwT8axnLJLgAAEABBBJn6m5zeeE0jTsJLBdBcO2W0QphoBdXCeqn6wbgx3UZmYUdtSuktXY57bis6vM8HzZ/JeAEuvCxKy6c8tLV6n2Mi7SddXrbatdUJIQb6aZEOGmXYt27XHyEwwLExwqOmiUa/urJTtik2QMZlfE6mEnJNqthmLmmeBFL/AszgbK9l2e7e2CI+I9KSAXMOzumvTb30ISXrrobxFNPNkQv7jM67CcG0eoadp3giVdEk7FU6m3Rs0A==
```

### 10.4 Janela minimizada (de verdade, aplicativo instalado)

`xdotool windowminimize` na janela cujo título era `Lab Web Push com VAPID - Lab: Web Push com VAPID`. O FCM respondeu **201** em `Thu, 29 Oct 2026 02:29:40 GMT`, endpoint `d_5p…AnPj`.

```text
ttl: 3600
urgency: high
topic: lab
content-encoding: aes128gcm
content-length: 187
authorization: vapid t=eyJ0eXAiOiJK…gdlVBQ, k=BG8kU5…YSBg
```

```json
{
  "payload": {
    "aud": "https://fcm.googleapis.com",
    "exp": 1793284180,
    "sub": "mailto:webpush-lab@luizschons.com"
  },
  "signatureValid": true
}
```

`exp` 1793284180 é `2026-10-29T14:29:40Z`. `location: https://fcm.googleapis.com/0:1793240980846213%2fd9afcd0001a18d`. O service worker leu, igual:

```text
{"title":"PWA minimizado","body":"A janela do aplicativo foi minimizada.","url":"/"}
```

O dunst mostrou essa notificação. A captura é `docs/pwa-notificacao-minimizada.png`. Corpo cifrado, 187 bytes, SHA-256 `36a16a78b999d5a8ec66acb9fa34c4515849f10e10758d0fb8aa988b3b4479b5`. O plaintext não está dentro.

```text
2Dsed+1mA7hptZJIRFqioQAAEABBBOTmknrr/qxzWGtc/mfbSdWg4Yk/lqT+Zzm4CWfTQLe8f8D2PZ/1tvTC6fF7ErGl7jnRHOLEFr3eXv7YoCblk561BrqCRXrGh0hkFIMJSJtMdWIwiq+KdNKe81l0SRgEibHAMZzEL5aOEXx4vTRNsTHpIGXUXHWqd+9IEzNdzgnxrTE2vTuKXRD4EbIVyiJboYczveN015NUSNWj0vD4J/ovVSu1jw==
```

Não cliquei nessa notificação. O clique medido é o da seção 10.5.

### 10.5 Janela fechada, Chrome ainda aberto, e o clique (de verdade)

Fechei as janelas do site. Sobrou uma aba `chrome://new-tab-page/` e um `about:blank`, para o processo não morrer. `serviceWorkers` continuou 1. O FCM respondeu **201** em `Thu, 29 Oct 2026 02:29:42 GMT`, de novo em `d_5p…AnPj`.

```text
ttl: 3600
urgency: high
topic: lab
content-encoding: aes128gcm
content-length: 203
authorization: vapid t=eyJ0eXAiOiJK…NmF3lg, k=BG8kU5…YSBg
```

```json
{
  "header": { "typ": "JWT", "alg": "ES256" },
  "payload": {
    "aud": "https://fcm.googleapis.com",
    "exp": 1793284182,
    "sub": "mailto:webpush-lab@luizschons.com"
  },
  "signatureValid": true
}
```

`exp` 1793284182 é `2026-10-29T14:29:42Z`. `location: https://fcm.googleapis.com/0:1793240982478976%2fd9afcd0001a18d`. O service worker, sem janela do site, postou:

```text
{"title":"PWA com a janela fechada","body":"A janela foi fechada. O Chrome segue aberto.","url":"/"}
```

O dunst desenhou essa notificação (`docs/pwa-notificacao.png`). O barramento recebeu o `Notify` com esse texto. Corpo cifrado, 203 bytes, SHA-256 `101ae2b1d3886442e1cf255d04a0465237b3df73c905457c5049f80c91f67dd6`. O plaintext não está dentro.

```text
el+mdJZsRvsmwcu1cAmR8AAAEABBBJGPUTNFP1KgqV4+R4BNQi4tKwKuCu3JvK2fppEeNEKnFz9tgCi4drzqO5+Tv9v57iS+W8FQJyNV1X9J7VGPA/tET91WSaS3L2tdhCrQTTK/3GRqg8rh8maJ77CgZhidBCundj6zPIbb3lYRVdmmMOvg+MU7XFnXrQR+7K9/7TrlyYU4amXH8Me4MjKFg3EQjMldiFplAJTk1UgatJqiYennQUF3EjnMvGBhci7yagq1v9oFdJg=
```

O clique foi `dunstctl action`, a ação padrão do daemon, às 02:29:43.840Z. Não foi um `dispatchEvent` fabricado na página. O service worker postou em `/lab/notification-click`:

```json
{
  "url": "http://127.0.0.1:8788/",
  "action": "openWindow",
  "focused": false,
  "opened": true,
  "clientCount": 0
}
```

`clientCount: 0` quer dizer que `clients.matchAll` não achou janela do site, então o código não chamou `focus()`. Chamou `clients.openWindow`. `opened: true` é o retorno dessa chamada. A janela que apareceu é a do aplicativo instalado: sem barra de endereço, `display-mode: standalone`, e o documento dela mostrou o bloco “O clique na notificação” com `ação: openWindow` e `modo agora: standalone`. `document.hasFocus()` nesse documento estava `true` quando a prova leu. Outras janelas do mesmo Chrome (`chrome://new-tab-page/` e `about:blank`) também responderam `hasFocus: true` na mesma leitura, então não trato isso como exclusividade do foco do sistema. O que está provado é que o clique abriu a janela do PWA instalado.

Capturas: `docs/pwa-foco-apos-clique.png` (a janela) e `docs/pwa-clique-registrado.png` (o texto que a página mostrou). A bolha do Google Tradutor aparece na janela. Ela não fez parte do clique.

### 10.6 Processo do Chrome encerrado (de verdade, e a notificação não apareceu enquanto ele estava morto)

`context.close()` encerrou o Chrome. `ps` não achou processo com o perfil desta prova. Aí o envio foi feito.

O FCM respondeu **201** em `Thu, 29 Oct 2026 02:29:46 GMT`, endpoint `d_5p…AnPj`. Aceitar o armazenamento não é entregar ao service worker. Durante os 15 segundos com o Chrome morto não houve `POST /lab/push-received` e o dunst não recebeu esse texto.

```text
ttl: 3600
urgency: high
topic: lab
content-encoding: aes128gcm
content-length: 212
authorization: vapid t=eyJ0eXAiOiJK…pnZkXQ, k=BG8kU5…YSBg
```

```json
{
  "payload": {
    "aud": "https://fcm.googleapis.com",
    "exp": 1793284186,
    "sub": "mailto:webpush-lab@luizschons.com"
  },
  "signatureValid": true
}
```

`exp` 1793284186 é `2026-10-29T14:29:46Z`. `location: https://fcm.googleapis.com/0:1793240986910820%2fd9afcd0001a18d`. SHA-256 `4b0440a4ed7619ad08608d489f8425e2d9ef33092bcc50a9e31673bbe3a9a69f`. O plaintext não está no ciphertext.

```text
7dAfS7r4WsifQWb9XlLqNAAAEABBBBkxCyxpGZIHYfq/YjxJlO4F4uZFO/AGsdYvg00B0eGlqmUefBoNUfYs/lWNQFa9cs7Uo9xhv9iQADuPSOhOUBd+TDmRNSBP7JkNgMfkWmP/5vr9rUdR4WczFQO55cX9bYF99R7GC7W5t6/HX7BqWDZflXE6wC6x49Xb6b7a5U38i+ekwvzVgyfnRa/BQL+Mynwlfg8n0wUJQREUyo1uG1vMzNKWTDcxfdr8eUsD1ifYrF2Pccir3ObFQV4Kxv8=
```

Reabri o mesmo perfil. Em `2026-10-29T02:30:04.801Z` o service worker leu o JSON, e o dunst desenhou a notificação (`docs/pwa-notificacao-chrome-reaberto.png`):

```text
{"title":"PWA com o Chrome fechado","body":"O processo do Chrome foi encerrado antes deste envio.","url":"/"}
```

O FCM tinha guardado a mensagem. Ela chegou quando o Chrome voltou. Não chegou com o processo encerrado.

### 10.7 O que esta rodada não testou

- **iPhone, iPad e Safari.** Não havia aparelho. Não há endpoint da Apple. O manifesto não foi conferido no iOS.
- **Firefox.** O binário não está nesta máquina. Não há endpoint da Mozilla.
- **Android.** Não havia aparelho nem emulador.
- **`pushsubscriptionchange`.** O service worker escuta o evento. Esta execução não gravou essa lista, então não afirmo que disparou ou que deixou de disparar.
- **Notificação em primeiro plano do aplicativo já instalado.** O estado foi testado. O FCM respondeu 410 e nada foi exibido. A notificação em primeiro plano que existe é a da aba, na seção 10.3, antes da instalação.
- **Clique que chama `focus()` numa janela que já estava aberta.** O clique medido achou zero janelas e usou `openWindow`. Não exercitei o ramo do `focus()` com um cliente já existente.
