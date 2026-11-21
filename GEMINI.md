# Amélie WhatsApp Bot (Gleam/BEAM)

Amélie is an intelligent WhatsApp assistant written in Gleam, targeting the Erlang/BEAM runtime. It utilizes a strict hexagonal architecture (Ports & Adapters) with a pure functional core, interacting with WhatsApp via a Go `whatsmeow` bridge and AI providers (Google Gemini primary, OpenRouter fallback/alternative).

## Project Overview

- **Purpose:** Multimodal WhatsApp assistant capable of processing text, images, audio, video, documents, and stickers.
- **Architecture:** Ports & Adapters (Hexagonal Architecture).
- **Core Technologies:**
  - **Language:** [Gleam](https://gleam.run/) (Erlang target)
  - **Runtime:** Erlang/OTP (BEAM)
  - **HTTP Server:** [Mist](https://github.com/lpil/mist)
  - **Database:** SQLite (via [sqlight](https://github.com/lpil/sqlight))
  - **AI Providers:** Google Gemini (primary), OpenRouter (fallback/alternative)
  - **WhatsApp Bridge:** [whatsmeow](https://github.com/tulir/whatsmeow) (Go)
  - **Media Processing:** `ffmpeg`, Python PIL, and `libwebp-tools` (`webpmux`, `dwebp`)

## Directory Structure

```text
src/
├── adaptadores/      # Concrete implementations of ports (HTTP clients, SQLite)
│   ├── config_sqlite.gleam
│   ├── gemini_http.gleam
│   ├── grupo_sqlite.gleam
│   ├── historico_sqlite.gleam
│   ├── openrouter_http.gleam
│   ├── prompt_sqlite.gleam
│   ├── telegram_http.gleam
│   ├── transacao_sqlite.gleam
│   ├── usuario_sqlite.gleam
│   └── whatsmeow_http.gleam
├── core/             # Pure business logic (Processor, Command Dispatcher, Validations)
│   ├── comando/
│   │   └── dispatcher.gleam
│   ├── prompt/
│   │   └── builder.gleam
│   ├── acessibilidade.gleam
│   ├── despachante_ia.gleam
│   ├── processador.gleam
│   └── validacao.gleam
├── dominio/          # Pure domain types
│   ├── acao.gleam
│   ├── config.gleam
│   ├── erro.gleam
│   ├── mensagem.gleam
│   ├── provedores_config.gleam
│   └── transacao.gleam
├── portas/           # Port interfaces (Abstract types as records of functions)
│   ├── config_porta.gleam
│   ├── grupo_porta.gleam
│   ├── historico_porta.gleam
│   ├── ia_porta.gleam
│   ├── mensageiro_porta.gleam
│   ├── prompt_porta.gleam
│   ├── transacao_porta.gleam
│   └── usuario_porta.gleam
├── shell/            # Effectful orchestration layer (Executes Acao values, OTP Actors)
│   ├── cache_ia.gleam
│   ├── disjuntor.gleam
│   ├── entrega_auditada.gleam
│   ├── fila_midia.gleam
│   ├── fila_offline.gleam
│   ├── tratador_mensagem.gleam
│   ├── ia_resiliente.gleam
│   ├── manutencao.gleam
│   ├── metricas.gleam
│   └── extrator_url.gleam
├── amelie_ffi.erl       # Erlang FFI (OS env, file IO, BEAM metrics)
└── amelie.gleam         # Entry point: Wires everything and starts Mist HTTP server
whatsmeow-bridge/     # Go bridge for connecting to WhatsApp via whatsmeow
config/               # Configuration files (providers.yaml)
db/                   # SQLite database files
test/                 # Test suite (mirrors src/ structure)
```

## Building and Running

### Commands

- **Build:** `gleam build`
- **Test:** `gleam test` (175 tests passing)
- **Bridge Tests:** `cd whatsmeow-bridge && go test -count=1 ./...`
- **Run (Local):**
  ```bash
  GEMINI_API_KEY=your_key WHATSMEOW_URL=http://localhost:8080 DB_PATH=./db/amelie.sqlite PORT=4000 gleam run
  ```
- **Deployment (Docker):** `docker compose up -d --build` (starts both the Gleam app and the Go bridge in unified container)

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `GEMINI_API_KEY` | `""` | Google Gemini API key (primary) |
| `OPENROUTER_API_KEY` | `""` | OpenRouter API key (alternative/fallback) |
| `TELEGRAM_BOT_TOKEN` | `""` | Telegram Bot API token (enables Telegram channel) |
| `TELEGRAM_SECRET_TOKEN` | `""` | Secret token to authenticate Telegram incoming webhook (optional) |
| `TELEGRAM_ADMIN_CHAT_ID` | `""` | Admin Telegram Chat ID for RBAC `/status`, `/reset_whatsapp`, `/parear` |
| `MOBILE_NUMBER` | `""` | Bot phone number for pairing code (optional) |
| `WHATSMEOW_URL` | `http://localhost:8080` | URL of the whatsmeow-bridge |
| `DB_PATH` | `/data/amelie.sqlite` | Path to the SQLite database |
| `BRIDGE_DB_PATH` | `/data/bridge/whatsapp.db` | Path to the WhatsApp session database |
| `PORT` | `4000` | HTTP server port |
| `BRIDGE_PORT` | `8080` | Internal bridge port |
| `OFFLINE_RETRY_INTERVAL_MS`| `30000` | Interval for retrying offline messages (ms) |

## Development Conventions

### Hexagonal Architecture Principles
- **Pure Core:** Logic in `core/` and `dominio/` must remain pure. No side effects, no external network or file IO.
- **Port-Based Dependency:** The shell and core interact with external systems exclusively through interfaces defined in `portas/`.
- **Multichannel Routing:** Messages from WhatsApp and Telegram use unified domain logic; `adaptadores/roteador_mensageiro` routes output actions to the respective adapter by chat ID prefix (`tg:` vs WhatsApp JID).
- **Acao Pattern:** The core never performs actions; it returns `List(Acao)` which prescribes what the shell should execute:
  - `GerarEEnviar(para, prompt)`: triggers AI generation and sends the response.
  - `EnviarResposta(para, corpo)`: sends canned or command output directly.
  - `EnfileirarMidia(chat_id, tipo)`: routes to concurrent OTP media workers.
  - `BuscarUrlEResponder(para, texto, url)`: fetches web page content before generating AI response.
  - Video links (YouTube, Instagram, TikTok) get `EnviarResposta` with `processador.aviso_link_video_desativado`; downloading them is disabled for SSRF protection.

### Workflow & Reliability
- **Non-blocking Webhooks:** Both `/webhook` (WhatsApp) and `/webhook/telegram` return `202 Accepted` immediately. Processing happens in an isolated process via `spawn_fn`.
- **Media Offloading via Temp Files:** Large incoming media (images, audio, video, documents, stickers) is saved by the bridge to `/tmp/amelie_midia_*` and read/deleted by the Gleam application, eliminating Mist HTTP body overflow. Telegram media is downloaded asynchronously using Bot API `getFile`.
- **Deduplication & Transaction Audit:** Messages are tracked in the `transacoes` table to ensure at-most-once processing and retry tracking.
- **Message Age Filter:** Messages older than 48 hours are ignored to prevent responding to old history on startup.
- **Strict Telegram Privacy Filter:** Group chats in Telegram are categorically rejected (`chat.type != "private"`).
- **Async Media Queues:** Media processing is handled by dedicated OTP actors in `shell/fila_midia.gleam` (`imagem`, `audio`, `video`, `documento`, `sticker`).
- **Resilient AI Layer:** `shell/ia_resiliente.gleam` wraps provider calls with exponential backoff retry (up to 3 attempts), provider-specific circuit breaking (`shell/disjuntor.gleam`), and in-memory caching (`shell/cache_ia.gleam`).
- **Bridge Reliability & Self-Healing:**
  - HTTP server on `:8080` starts immediately before attempting WhatsApp connection, making `/health`, `/pair-phone` and `/reset-session` available even during disconnections.
  - Resetting sessions (`POST /reset-session`) recreates devices via `container.NewDevice()` and instantiates a clean `whatsmeow.Client`, avoiding `ErrDeviceDeleted`.
  - Pairing code timeout does not terminate the process (`log.Fatalf` removed).
  - Supervisor loop in `entrypoint.sh` restarts bridge automatically if killed.
  - Asynchronous retry with backoff (5 attempts) for event notifications to Gleam (`notifyGleamEvent`).
- **Consolidated Healthcheck:** `GET /health` aggregates status from SQLite, the whatsmeow bridge, Telegram, and BEAM runtime metrics (memory and process count).
- **Remote RBAC Administration:** Telegram admin (`TELEGRAM_ADMIN_CHAT_ID`) can query `/status` and manage session resets via `/reset_whatsapp` and `/parear <phone>`.

### Coding Style
- **Gleam Patterns:** Prefer `use` for monadic operations (Result, Option, Decoder).
- **JSON Decoding:** Use `gleam_json` decoders. Note that `sqlight` decoders use positional indexing (`decode.at([0], ...)`).
- **FFI:** Erlang FFI is used for system-level calls (OS environment, process spawning, file reading/deletion, memory inspection) in `src/amelie_ffi.erl`.

## Key Logic Paths

1. **Incoming Message:** `POST /webhook` or `POST /webhook/telegram` -> Decodes to `Webhook` -> Reads/downloads media -> Calls `tratador_mensagem.tratar`.
2. **Pure Decision:** `tratador_mensagem` fetches `Config` and `Historico` -> Calls `core/processador.processar` (Pure) -> Receives `List(Acao)`.
3. **Execution:** `tratador_mensagem` iterates over `Acao` list and executes each via relevant ports (`despachante_ia`, `roteador_mensageiro`, `historico`, `transacoes`).
