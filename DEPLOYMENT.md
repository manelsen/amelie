# Deployment — Amélie

## Estrutura de Arquivos

```text
amelie/
├── src/                    # Código Gleam (core funcional, portas, adaptadores, shell)
├── whatsmeow-bridge/       # Bridge Go (conectividade WhatsApp via whatsmeow)
├── config/                 # Configuração externa de provedores (providers.yaml)
├── db/                     # Volume persistente (SQLite da aplicação + sessão WhatsApp)
├── Dockerfile              # Imagem unificada multi-stage (bridge + app + ffmpeg)
├── entrypoint.sh           # Inicializa bridge em background e Gleam em foreground
├── docker-compose.yml      # Definição do serviço unificado
├── .env.example            # Template de variáveis de ambiente
└── .env                    # Variáveis locais e chaves de API (NÃO commitar!)
```

## Deploy

### Pré-requisitos
- Docker Engine e Docker Compose (plugin v2 ou binário integrado).

### Passo a Passo

```bash
# 1. Copiar o template de variáveis de ambiente
cp .env.example .env

# 2. Gerar um segredo e copiar o resultado para BRIDGE_TOKEN no .env
openssl rand -hex 32

# 3. Editar .env: BRIDGE_TOKEN, chaves de API e seu TELEGRAM_ADMIN_CHAT_ID
nano .env

# 4. Construir e iniciar os containers em background
docker compose up -d --build
```

### Conectar o WhatsApp

O bridge whatsmeow exibe o QR Code ou utiliza Pairing Code diretamente nos logs:

```bash
docker compose logs -f
```

- **Via QR Code:** Abra o WhatsApp → *Aparelhos Conectados* → *Conectar um aparelho* e escaneie o código gerado no terminal.
- **Via Pairing Code:** Defina a variável `MOBILE_NUMBER` no seu `.env` com seu número completo (ex: `5531999990000`) e confirme o código de pareamento no celular. O código chega ao administrador pelo Telegram (`TELEGRAM_ADMIN_CHAT_ID`) e não aparece no log, porque quem lê os logs poderia vincular um aparelho à conta. Sem Telegram configurado, defina `PAIRING_CODE_IN_LOG=1` para exibi-lo no log durante o pareamento e remova a variável depois.

### Grupos

A Amélie atende só conversas privadas. Se alguém a adicionar a um grupo do
WhatsApp, ela sai sozinha e não processa nada do que chega dali. Como camada
extra, no celular do número do bot, ajuste *Configurações → Privacidade → Grupos*
para *Meus contatos*: isso impede que estranhos a coloquem em grupos.

### Comandos Úteis

```bash
docker compose logs -f          # Acompanhar logs em tempo real
docker compose restart          # Reiniciar o serviço
docker compose down             # Parar o serviço
docker compose up -d --build    # Rebuild e reinicialização
docker compose exec amelie sh   # Acessar shell interno para depuração
```

## Variáveis de Ambiente (`.env`)

| Variável | Default | Descrição |
|---|---|---|
| `GEMINI_API_KEY` | — | Chave da Google Gemini API (**obrigatório**) |
| `OPENROUTER_API_KEY` | — | Chave OpenRouter (opcional para modelos adicionais) |
| `TELEGRAM_BOT_TOKEN` | — | Token da Telegram Bot API gerado via @BotFather (opcional) |
| `TELEGRAM_SECRET_TOKEN` | — | Obrigatório para webhook; vazio rejeita todas as requisições ao endpoint. Polling continua disponível |
| `TELEGRAM_ADMIN_CHAT_ID` | — | Chat ID do administrador no Telegram para alertas e comandos restritos (opcional) |
| `BRIDGE_TOKEN` | — | Obrigatório: segredo aleatório de pelo menos 32 caracteres, igual no bridge e no Gleam |
| `BRIDGE_HOST` | `127.0.0.1` | Interface de escuta do bridge; mantenha privada |
| `MEDIA_TEMP_DIR` | `/tmp/amelie-media` | Diretório compartilhado entre bridge e Gleam, com permissão 0700 |
| `MOBILE_NUMBER` | — | Número de telefone para Pairing Code (ex: `5531999990000`) |
| `PAIRING_CODE_IN_LOG` | — | `1` exibe o código de pareamento no log. Use só durante o pareamento sem Telegram |
| `DB_PATH` | `/data/amelie.sqlite` | Caminho do SQLite da aplicação Gleam |
| `BRIDGE_DB_PATH` | `/data/bridge/whatsapp.db` | Caminho do SQLite de sessão do WhatsApp |
| `PORT` | `4000` | Porta HTTP da aplicação Gleam (acessível no host em `127.0.0.1:4001`) |
| `BRIDGE_PORT` | `8080` | Porta interna do bridge whatsmeow (não exposta publicamente) |
| `OFFLINE_RETRY_INTERVAL_MS`| `30000` | Intervalo em milissegundos para reprocessamento de mensagens offline |

> [!NOTE]
> `WHATSMEOW_URL` e `GLEAM_URL` são injetados automaticamente pelo script [`entrypoint.sh`](entrypoint.sh) e não precisam ser declarados no `.env`.

## Administração e Pareamento Remoto

Quando o bot do Telegram estiver configurado com `TELEGRAM_ADMIN_CHAT_ID`, você pode gerenciar o estado da aplicação e do WhatsApp diretamente pelo Telegram, sem precisar abrir o terminal ou reiniciar os containers:

- **`/status`:** Exibe um relatório em tempo real contendo:
  - Estado da conexão do WhatsApp (conectado, desconectado, autenticado).
  - Estado do canal Telegram (habilitado, pronto).
  - Métricas do BEAM Erlang (memória total consumida e contagem de processos ativos).
  - Total de mensagens recebidas, processadas e eventuais erros.
- **`/reset_whatsapp`:** Desconecta e limpa a sessão local do WhatsApp com segurança (recriando o dispositivo no banco e reiniciando a rotina) e envia imediatamente um novo código de pareamento no seu chat do Telegram.
- **`/parear <numero>`:** Solicita um novo Pairing Code sob demanda para o número especificado (formato com DDD e nono dígito: ex. `5531999990000`).

## Dados, Volumes e Backup

Todos os dados persistentes ficam montados no volume `./db/` (mapeado para `/data` dentro do container):

```text
db/
├── amelie.sqlite          # Banco da aplicação: configs de chat, histórico, prompts, transações
└── bridge/
    └── whatsapp.db        # Banco da sessão do whatsmeow (chave criptográfica do aparelho)
```

### Backup do Banco de Dados

```bash
docker compose exec amelie sh -c \
  "cp /data/amelie.sqlite /data/amelie_backup_\$(date +%Y%m%d).sqlite"
```

Para incluir a sessão do WhatsApp, faça backup de toda a pasta `db/`:

```bash
tar -czvf backup_amelie_$(date +%Y%m%d).tar.gz db/
```

### Restauração

```bash
docker compose down
tar -xzvf backup_amelie_YYYYMMDD.tar.gz
docker compose up -d
```

## Resolução de Problemas (Troubleshooting)

1. **Sessão desconectada ou erro 401 (`whatsapp_logged_out`):**
   O WhatsApp revogou o token do aparelho. Você pode enviar `/reset_whatsapp` diretamente pelo Telegram ou parar o container, remover `db/bridge/whatsapp.db` e subir o container novamente para parear.
2. **Erro de DNS em downloads de mídia (`a.whatsapp.net`):**
   O `docker-compose.yml` já inclui `extra_hosts: ["a.whatsapp.net:57.144.249.32"]` para contornar falhas de resolução dos domínios MMS do WhatsApp em certas redes e provedores.
3. **Verificação de Saúde (Healthcheck Consolidado):**
   - Acesse o endpoint unificado: `curl http://localhost:4001/health`
   - O retorno consolida o estado do SQLite, WhatsApp Bridge (`connected`, `logged_in`), Telegram e métricas BEAM:
     ```json
     {
       "status": "ok",
       "sqlite": "ok",
       "whatsapp_bridge": {
         "connected": true,
         "logged_in": true,
         "jid": "553199990000:96@s.whatsapp.net"
       },
       "telegram": { "status": "enabled" },
       "beam": { "memory_total_mb": 40.2, "process_count": 116 }
     }
     ```
4. **Links de vídeos:**
   Downloads com extratores externos estão desativados por segurança. Envie o arquivo diretamente pelo WhatsApp ou Telegram.

## Atualização de segurança

Antes de subir esta versão, configure `BRIDGE_TOKEN` em ambos os processos. O
entrypoint e os binários recusam inicialização sem um segredo de pelo menos 32
caracteres. Gere-o aleatoriamente; não use uma frase nem reutilize uma chave de IA.
Não envie o segredo para páginas externas.

O Compose publica a porta apenas em `127.0.0.1`. Para Telegram por webhook, use um
proxy HTTPS que exponha **somente** `/webhook/telegram` e configure o mesmo
`TELEGRAM_SECRET_TOKEN` no registro do webhook junto ao Telegram. Os endpoints
`/webhook` e `/webhook/bridge-event` são privados e exigem
`X-Amelie-Bridge-Token`. Sem segredo Telegram, o endpoint fica fechado e o polling
continua funcionando. `TELEGRAM_ADMIN_CHAT_ID` vazio desabilita comandos remotos;
quando configurado, eles exigem mensagem privada do próprio administrador.

`GET /health` sem autenticação devolve só o status agregado (`ok`, `degraded` ou
`error`). O detalhe (estado do WhatsApp, métricas da BEAM, erro do SQLite) exige o
cabeçalho `X-Amelie-Bridge-Token` com o mesmo `BRIDGE_TOKEN`:

```bash
curl -s -H "X-Amelie-Bridge-Token: $BRIDGE_TOKEN" http://127.0.0.1:4001/health
```

O spool de mídia do bridge mudou para `MEDIA_TEMP_DIR`, um diretório 0700. Apenas
arquivos regulares diretamente nele, com nomes gerados pelo bridge, sem links e
com até 50 MiB são aceitos. Mídias antigas pendentes em `/tmp/amelie_midia_*` serão
rejeitadas após a atualização e deverão ser reenviadas. Não habilite compatibilidade
com caminhos antigos vindos de payloads.

A leitura de páginas usa o endpoint autenticado `/fetch` do bridge, inclusive para
mensagens Telegram. O cliente só permite HTTP/HTTPS nas portas padrão, valida os
IPs no momento de conectar e em cada redirecionamento, mantém a verificação TLS e
limita a resposta a 1 MiB e a operação a 15 segundos. O bridge precisa estar
rodando para esse recurso.

O download de links por `yt-dlp` foi desativado: seus extratores podem abrir
conexões adicionais que escapam da validação da URL inicial. Vídeos enviados como
arquivo continuam disponíveis. Reativar downloads exige um serviço isolado com
controle de tráfego de saída; não basta uma lista de hosts na URL recebida.

### Container sem root

O container sobe como root apenas para preparar o volume e então passa a rodar
como o usuário sem privilégios `amelie`, via `su-exec`. Na primeira subida depois
da atualização, o entrypoint ajusta o dono de `./db` (montado em `/data`) para
`amelie`; o log mostra `Ajustando dono de /data` uma única vez. No host, o
diretório `./db` passa a pertencer ao UID desse usuário; os backups com `cp -a`
preservam isso.

O Compose também deixa o sistema de arquivos do container só leitura, com escrita
apenas em `/data` (volume) e `/tmp` (memória, até 1 GiB), descarta todas as
capabilities exceto `CHOWN`, `SETUID` e `SETGID` (usadas só pelo entrypoint) e
ativa `no-new-privileges`. Para conferir depois de subir:

```bash
sh test/container_hardening_test.sh
```

Se algum recurso falhar por escrita negada, o log aponta o caminho. Nesse caso,
comente temporariamente `read_only: true` no Compose e abra um ajuste para levar
aquele caminho para `/tmp` ou `/data`, em vez de remover o endurecimento.
