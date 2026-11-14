# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Amélie is a WhatsApp bot written in Gleam (targeting the BEAM/Erlang runtime). It receives webhook events from a `whatsmeow` Go bridge (`whatsmeow-bridge/`), processes them through a pure functional core, and responds via multimodal AI providers (Google Gemini primary, OpenRouter fallback/alternative).

**Structure:**
- `src/` — Gleam code (hexagonal architecture: domain, core, ports, adapters, shell)
- `whatsmeow-bridge/` — Go bridge for WhatsApp connection via `whatsmeow`
- `config/` — External provider and model settings (`providers.yaml`)
- `docker-compose.yml` — Containerized unified deployment
- `DEPLOYMENT.md` — Full deployment and operations guide
- `ROADMAP.md` — Technical roadmap, status, and priorities

## Commands

### Development
```bash
# Build Gleam application
gleam build

# Run full Gleam test suite
gleam test

# Check formatting
gleam format --check src test

# Format code
gleam format

# Run Go bridge tests
cd whatsmeow-bridge && go test -count=1 ./...

# Build Go bridge binary
cd whatsmeow-bridge && go build .

# Run the Gleam app only (requires bridge running separately)
BRIDGE_TOKEN=... GEMINI_API_KEY=... WHATSMEOW_URL=http://localhost:8080 DB_PATH=./db/amelie.sqlite PORT=4000 gleam run
```

### Production (Docker Compose)
```bash
# Build and start services (bridge + Gleam app)
docker compose up -d --build

# View logs
docker compose logs -f

# Stop
docker compose down
```

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `GEMINI_API_KEY` | `""` | Google Gemini API key (primary) |
| `OPENROUTER_API_KEY` | `""` | OpenRouter API key (fallback/alternative) |
| `TELEGRAM_BOT_TOKEN` | `""` | Telegram Bot API token (enables Telegram channel) |
| `TELEGRAM_SECRET_TOKEN` | `""` | Required for incoming webhook; empty disables the endpoint (polling still works) |
| `TELEGRAM_ADMIN_CHAT_ID` | `""` | Admin Telegram Chat ID for RBAC `/status`, `/reset_whatsapp`, `/parear` |
| `MOBILE_NUMBER` | `""` | Bot phone number for WhatsApp Pairing Code (optional) |
| `WHATSMEOW_URL` | `http://localhost:8080` | whatsmeow HTTP bridge URL |
| `DB_PATH` | `/data/amelie.sqlite` | SQLite database path |
| `BRIDGE_DB_PATH` | `/data/bridge/whatsapp.db` | whatsmeow device/session SQLite path |
| `PORT` | `4000` | HTTP server port (Mist) |
| `BRIDGE_PORT` | `8080` | Internal bridge HTTP port |
| `OFFLINE_RETRY_INTERVAL_MS`| `30000` | Interval for retrying offline messages |
| `BRIDGE_TOKEN` | `""` | Required shared random secret, at least 32 characters |
| `BRIDGE_HOST` | `127.0.0.1` | Private bridge listener |
| `MEDIA_TEMP_DIR` | `/tmp/amelie-media` | Private 0700 spool shared by Gleam and bridge |

`WHATSMEOW_URL` and `GLEAM_URL` are configured automatically by `entrypoint.sh` inside Docker.

## Architecture

The codebase follows a strict **ports & adapters (hexagonal)** pattern with a pure functional core:

```text
dominio/       — Pure domain types. No side effects, no external dependencies.
core/          — Pure business logic. Deterministic. Receives data, returns List(Acao).
portas/        — Port interfaces (abstract types as records of functions).
adaptadores/   — Concrete implementations of ports (HTTP clients, SQLite).
shell/         — Effectful orchestration layer. Executes Acao values and OTP actors.
amelie_gleam.gleam — Entry point: wires adapters → ports, plus a thin Mist router (auth, body read, HTTP status). No business logic.
```

### Data Flow

1. `POST /webhook` (WhatsApp) → `adaptadores/whatsmeow_webhook` decodes the payload into `ponte_porta.Webhook(msg, arquivo)` and `shell/receptor_whatsapp` dispatches it. `POST /webhook/telegram` → `adaptadores/telegram_webhook` → `shell/receptor_telegram`. `POST /webhook/bridge-event` (connection down/up, pairing code) → `whatsmeow_webhook.decodificar_evento` → `shell/avisos_ponte`, which tells the admin through `MensageiroPorta`. `GET /health` → `shell/saude`.
2. Large incoming media from WhatsApp is offloaded to `MEDIA_TEMP_DIR/amelie_midia_*` by the bridge. `shell/receptor_whatsapp` reads the file via Erlang FFI (`arquivos_temporarios.ler_da_ponte`) into `BitArray`, then deletes the temporary file. Telegram media is fetched asynchronously via `getFile`.
   Messages sent while Amélie was offline, on either channel (timestamp more than `fila_atrasadas.limiar_atraso_s` behind arrival), go to `shell/fila_atrasadas`, a serial queue, and through `tratador_mensagem.tratar_atrasada`, which skips the rate limit (token bucket and flood) but keeps strike-3 quarantine and the daily cap. After a re-pairing, the bridge recovers them from the history sync (`history_recovery.go`): per private chat, user messages after Amélie's last reply, up to 48 h old.
3. `shell/tratador_mensagem.tratar` fetches `Config` + `Historico` from ports, calls `core/processador.processar`.
4. `core/processador` (pure) returns `List(Acao)` — never performs IO.
5. Shell executes each `Acao`:
   - `GerarEEnviar`: invokes AI provider via `despachante_ia` and sends reply via `entrega_auditada` (routed by `roteador_mensageiro` according to `chat_id`).
   - `EnviarResposta`: directly sends text (commands, help, errors) without invoking AI.
   - `EnfileirarMidia`: dispatches to `shell/fila_midia` — dedicated OTP actors for `imagem`, `audio`, `video`, `documento`, and `sticker`.
   - `BuscarUrlEResponder`: fetches public web content through the bridge’s authenticated `/fetch` endpoint, with DNS pinning, redirect checks, time and size limits.
   - Video links (YouTube, TikTok, Instagram…) are answered by the core with `EnviarResposta(processador.aviso_link_video_desativado)`: downloading external video is disabled for SSRF protection.

### Conversas privadas apenas

A Amélie só atende conversas privadas, nos dois canais. No WhatsApp, a ponte decide pelo servidor do JID do chat (`chat_policy.go`): privado é processado; grupo (`g.us`) é descartado e a Amélie sai do grupo, inclusive no evento `JoinedGroup`; qualquer outro (broadcast, status, canal) é só descartado. `IsGroup` não serve para isso, pois também é `true` para broadcast. No Telegram, `telegram_webhook` recusa grupos. O `core/processador` responde `NaoResponder` a qualquer mensagem com `em_grupo`, como segunda camada.

### Key Types

- `dominio/id_chat.IdChat` — opaque chat/user ID: `Telegram(Int)` or a WhatsApp JID. Build it with `telegram`, `whatsapp` (rejects text without `@` and anything starting with `tg:`) or `de_texto`; read it with `canal`, `numero_telegram`, `para_texto`. The text form (`tg:<n>` or the JID) exists only at the edges: SQLite, bridge/Bot API JSON, logs (`privacidade.mascarar`). Don't parse the `tg:` prefix anywhere else. The admin is `sistema.admin_chat_id() -> Option(IdChat)`.
- `dominio/mensagem.Mensagem` — chat_id and remetente (`IdChat`), corpo (`Conteudo`), timestamp, em_grupo, menciona_bot, legenda.
- `dominio/mensagem.Conteudo` — `Texto | Imagem | Audio | Video | Documento | Sticker | MidiaIndisponivel | Comando`.
- `dominio/acao.Acao` — `GerarEEnviar | BuscarUrlEResponder | EnviarResposta | EnfileirarMidia | SalvarConfig | LimparHistorico | AlterarModelo | SnapshotHistorico | NaoResponder`.
- `dominio/config.Config` — per-chat configuration (provedor, modelo default `gemini-3.5-flash-lite`, historico_max, media toggles, modo_descricao).
- `dominio/provedor.Provedor` — `Gemini | OpenRouter`. Text names exist only at the edges (`providers.yaml`, SQLite, `.modelo`); `provedores_config.validar_modelo` returns the typed provider, and an unknown name read from SQLite falls back to `Gemini`.
- `dominio/transacao.TipoEntrega` — `RespostaTexto | RespostaIA | DescricaoMidia(TipoMidia)`, stored as text in `transacoes.tipo`; keep `tipo_entrega_para_string` values stable.
- `shell/tratador/base.Portas` — record bundling all active port implementations.

### Ports (Abstract interfaces as record-of-functions)

`shell/` reaches external services only through these ports; `amelie_gleam.gleam` is the only place that builds adapters. Allowed imports per layer: `dominio` → `dominio`; `portas` → `dominio`; `core` → `core`, `dominio` (never `portas`); `adaptadores` → `adaptadores`, `dominio`, `portas`; `shell` → `shell`, `core`, `dominio`, `portas` (never `adaptadores`). `test/arquitetura_test.gleam` enforces this table on every `gleam test`, and also keeps infrastructure libraries (`sqlight`, `mist`, `gleam/httpc`) out of everything but `adaptadores` and the entry point. `shell/despachante_ia` routes AI calls to the configured provider's `IAPorta`. `dominio/provedores_config` only parses YAML text — the entry point reads `config/providers.yaml`.


- `portas/mensageiro_porta.MensageiroPorta` — send messages and reactions (WhatsApp bridge, Telegram).
- `portas/ia_porta.IAPorta` — Gemini / OpenRouter AI operations (text, image, audio, video, document, file upload/poll/delete).
- `portas/config_porta.ConfigPorta` — per-chat config persistence.
- `portas/historico_porta.HistoricoPorta` — conversation history persistence and snapshots.
- `portas/transacao_porta.TransacaoPorta` — delivery tracking and offline queue persistence.
- `portas/usuario_porta.UsuarioPorta` — user registration and listing.
- `portas/grupo_porta.GrupoPorta` — group registration and listing.
- `portas/prompt_porta.PromptPorta` — custom system prompts persistence.
- `portas/ponte_porta.PontePorta` — whatsmeow bridge operations other than messaging: status, pairing code, session reset, page fetch (`/fetch`). Also holds what the bridge sends in: `Webhook(msg, arquivo)` and `EventoPonte`.
- `portas/armazenamento_porta.ArmazenamentoPorta` — storage health (`verificar`), used by `shell/saude`.
- `portas/telegram_porta.TelegramPorta` — Bot API operations other than messaging: `getUpdates` long polling, chat actions (typed `AcaoChat`), file download.

### Adapters

- `adaptadores/whatsmeow_http` → implements `MensageiroPorta` (`criar`) and `PontePorta` (`criar_ponte`) for WhatsApp (calls Go bridge, parses structured `APIError` and network errors).
- `adaptadores/telegram_http` → implements `MensageiroPorta` (`criar`) and `TelegramPorta` (`criar_api`) for Telegram (sends text, chat actions, reactions, downloads media).
- `adaptadores/whatsmeow_webhook` → inbound: decodes the bridge's JSON (`decodificar_webhook`, `decodificar_evento`) and validates media paths in the spool. Counterpart of `telegram_webhook`.
- `adaptadores/roteador_mensageiro` → routes calls to `whatsmeow_http` or `telegram_http` by `id_chat.canal`.
- `adaptadores/gemini_http` → implements `IAPorta` (Google Gemini REST & File API).
- `adaptadores/openrouter_http` → implements `IAPorta` (OpenRouter API).
- `adaptadores/config_sqlite` → implements `ConfigPorta` (includes auto-migration to `gemini-3.5-flash-lite`).
- `adaptadores/historico_sqlite` → implements `HistoricoPorta`.
- `adaptadores/transacao_sqlite` → implements `TransacaoPorta`.
- `adaptadores/usuario_sqlite`, `grupo_sqlite`, `prompt_sqlite` → SQLite storage.
- `adaptadores/armazenamento_sqlite` → implements `ArmazenamentoPorta` (`SELECT 1`).

### Commands

Messages starting with `.` or `/` (or without prefix where supported) are parsed as bot commands:
- `.ajuda` / `/ajuda` — help text.
- `.reset` / `/reset` — reset chat configuration and conversation history.
- `.audio`, `.imagem`, `.video`, `.doc` — alternar processamento de mídia (toggle liga/desliga).
- `.legenda` — toggle video transcription vs description.
- `.longo` / `.curto` — toggle detailed vs concise image descriptions.
- `.cego` — accessibility mode for visually impaired users.
- `.modelo [provedor/modelo]` — display the active provider and model; switching (e.g. `.modelo gemini/gemini-2.5-pro`) is admin-only, because the list includes models far more expensive than the default.

#### Admin notices (Telegram, to `TELEGRAM_ADMIN_CHAT_ID`)
- WhatsApp down, back up, and new pairing code: `shell/avisos_ponte`, from the bridge's `/webhook/bridge-event`.
- AI provider down and back up: `shell/avisos_ia`, hooked into each provider's circuit breaker (`disjuntor`). At most one down/up pair per `disjuntor.intervalo_avisos_ms` (15 min) per provider; an outage that starts inside that window is announced when it ends, if the circuit is still open.
- Without `TELEGRAM_BOT_TOKEN`, the entry point passes no admin and nothing is sent.

#### Admin Commands (Telegram only, restricted to `TELEGRAM_ADMIN_CHAT_ID`)
- `/status` — real-time status of WhatsApp and Telegram channels, BEAM memory/process metrics, and message counters.
- `/reset_whatsapp` — unlinks WhatsApp session, resets session database, recreates client device, and triggers pairing code generation.
- `/parear <phone>` — generates a fresh WhatsApp pairing code for the specified phone number and delivers it directly to the admin in Telegram.

### FFI

`src/amelie_gleam_ffi.erl` provides Erlang FFI for:
- `get_env/1`, `now_ms/0` — OS environment variables and wall clock. Shell modules use them only through `shell/sistema` (`ler_env`, `ler_env_ou`, `agora_ms`, `agora_s`, `admin_chat_id`, `url_ponte`), which also offers `disparar` for unlinked processes; don't redeclare these externals elsewhere.
- `read_file/1` and `delete_file/1` — temporary media file reading and cleanup.
- `total_memory/0`, `processes_memory/0`, `process_count/0` — BEAM runtime metrics.

## Regras de trabalho

- Quando o usuário reportar que algo não funciona, rastrear o caminho completo do dado em runtime (quem chama → quem passa o argumento → quem envia ao serviço externo) antes de sugerir causa externa (deploy, cache, restart). Código que existe mas não é alcançado é código morto.
- `mist.read_body` em `amelie_gleam.gleam` deve ser no mínimo `20 * 1024 * 1024` para suportar payloads de mídia de entrada.
- Sempre rodar `gleam test` e `cd whatsmeow-bridge && go test -count=1 ./...` antes de concluir modificações.
- Seguir o padrão de commits convencionais em português (`feat`, `fix`, `chore`, `refactor`, `docs`).
- Nomes de módulos, funções, tipos e campos em português. Ficam como estão os termos técnicos consagrados (webhook, cache, token, status, upload, download, log, prompt, trace, sticker, follow-up), nomes de produto (Gemini, Telegram, WhatsApp, SQLite) e campos que espelham o JSON de APIs externas (`update_id`, `file_id`, `file_name`). "Bridge" é sempre "ponte".
