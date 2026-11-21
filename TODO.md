# TODO: Paridade `amelie-legacy` -> `amelie`

Este arquivo lista o status de paridade com o sistema legado (`manelsen/amelie-legacy`), registrando o que já foi implementado, o que foi vetado deliberadamente e os itens operacionais remanescentes.

## Já presentes aqui

Funcionalidades migradas e ativas na `amelie`:

- **Comandos:** `.ajuda`, `.reset`, `.audio`, `.imagem`, `.video`, `.doc`, `.legenda`, `.longo`, `.curto`, `.cego`, `.modelo [provedor/modelo]`.
- **Processamento Multimodal:**
  - Texto com histórico conversacional.
  - Imagem (descrição concisa e modo longo detalhado).
  - Áudio (transcrição via Gemini com sanitização de timestamps).
  - Vídeo (upload assíncrono na Gemini File API, polling e descrição).
  - Documentos (leitura e resumo de PDFs e arquivos textuais).
  - Figurinhas / Stickers (WebP estático, figurinhas animadas convertidas para MP4 via PIL/ffmpeg ou grade de quadros via `webpmux`/`dwebp`, além de fallback textual por metadados).
  - Links de vídeo (YouTube, Instagram, TikTok) recebem aviso pedindo o arquivo; o download externo foi desativado por risco de SSRF.
- **Persistência SQLite:**
  - Configuração por chat com migração automática para `gemini-3.5-flash-lite`.
  - Histórico de turnos com limite configurável.
  - Auditoria transacional de entregas (`transacoes`) para deduplicação e retry.
  - Registro de usuários, grupos e prompts nomeados.
- **Conectividade WhatsApp:**
  - Bridge Go baseado no `whatsmeow` com pareamento via QR Code e Pairing Code.
  - Respostas citando mensagem original (`ContextInfo`) e reações por emoji.
  - Fila local no bridge em SQLite para entrega persistente ao Gleam.
  - Tráfego de arquivos grandes via disco temporário (`/tmp/amelie_midia_*`).
  - Diagnóstico e propagação de estado de sessão e erros estruturados de conexão (`/health`, `/send`, `/react`).
- **Resiliência e IA:**
  - Dispatcher multi-provedor (`gemini` e `openrouter`).
  - Retry exponencial com jitter para erros transientes de IA.
  - Circuit Breaker por provedor (`Fechado`, `Aberto` 60s, `SemiAberto`).
  - Cache de respostas em memória (SHA-256 de prompt + modelo, TTL 1h, max 500).
  - Limpeza periódica de transações antigas (+7 dias) a cada 6h.
  - Telemetria de memória BEAM e contagem de processos via FFI Erlang.

---

## Status das Lacunas Mapeadas

### 1. Comandos do legado vetados via chat

- [x] ~~`.prompt`~~ — vetado no chat (abuso por usuários; futuro: CLI admin)
- [x] ~~`.config`~~ — vetado no chat (abuso por usuários; futuro: CLI admin)
- [x] ~~`.users`~~ — vetado no chat (futuro: CLI admin)
- [x] ~~`.filas`~~ — vetado no chat (futuro: CLI admin)

### 2. Configuração operacional

- [x] Expor seleção de `provedor` e `modelo` por comando com persistência (`.modelo provedor/modelo`).
- [x] Validação de provedores e modelos a partir de `config/providers.yaml`.
- [x] Migração automática de configurações legadas para o novo padrão `gemini-3.5-flash-lite`.

### 3. Resiliência de entrega

- [x] Ciclo de auditoria transacional completo: registrar → enviar → marcar sucesso/falha (`shell/entrega_auditada.gleam`).
- [x] Fila offline periódica para reenvio com limite de tentativas (`shell/fila_offline.gleam`).
- [x] Classificação de erros de transporte e estruturados do whatsmeow (`src/adaptadores/whatsmeow_http.gleam`).
- [ ] Preservar contexto da resposta pendente caso haja reinício forçado durante chamada síncrona longa.

### 4. UX e mídia

- [x] Resposta citando a mensagem original com fallback automático quando `message_id` for ausente.
- [x] Extração e leitura de URLs em mensagens de texto (`extrator_url.gleam`).
- [x] Suporte completo a figurinhas animadas (conversão para vídeo MP4 ou grade de quadros).
- [x] Fallback de metadados quando mídia de sticker expira no WhatsApp.
- [x] Links de vídeo (YouTube, Instagram, TikTok) respondidos com aviso; download externo desativado por SSRF.

### 5. Resiliência de IA

- [x] Retry com backoff exponencial (max 3 tentativas) para erros transientes (429, 503, ErroComunicacao) — `shell/ia_resiliente.gleam`.
- [x] Circuit breaker por provedor (5 falhas → Aberto 60s → SemiAberto) — `shell/disjuntor.gleam`.
- [x] Cache de respostas em memória (SHA-256 de prompt+modelo, TTL 1h, max 500) — `shell/cache_ia.gleam`.
- [ ] Rate limiting granular na borda — baixa prioridade graças ao modelo de concorrência por atores do BEAM.

### 6. Operação e manutenção

- [x] Rotina periódica de limpeza de transações antigas (+7 dias) — `shell/manutencao.gleam`.
- [x] Telemetria de memória e processos do runtime BEAM — `metricas.formatar`.
- [x] Limpeza automática de arquivos temporários de mídia órfãos no bridge Go (`cleanupOrphanMediaFiles`).
- [x] Exposição de métricas e status operacional via comando administrativo com RBAC (`/status` no Telegram) e healthcheck consolidado (`GET /health`).

---

## Prioridades Atuais

### P0 — Concluído ✅
- Auditoria transacional e fila offline.
- Paridade de mídia (incluindo stickers, vídeos sociais e áudio).
- Propagação de erros de conexão do WhatsApp.

### P1 — Concluído ✅
- Citação de resposta e fallback.
- Detecção e leitura de URLs em mensagens.
- Provedor configurável (`.modelo`) e migração para `gemini-3.5-flash-lite`.
- Circuit Breaker, Cache de IA e telemetria BEAM.

### P2 — Multicanal e Operação — Concluído ✅
- [x] Canal de entrada Telegram com paridade multimodal total (Texto, Fotos, Voz/Áudio, Vídeos até 20MB, Documentos até 20MB, Stickers WebP/WebM, Chat Actions e Reações compatíveis).
- [x] Estado de sessão do WhatsApp e telemetria BEAM visíveis no healthcheck consolidado (`GET /health`) da aplicação Gleam.
- [x] Comandos remotos com RBAC via Telegram (`/status`, `/reset_whatsapp`, `/parear <numero>`) restritos a `TELEGRAM_ADMIN_CHAT_ID` e com entrega automática do pairing code.
- [x] Resiliência de ponta a ponta no Whatsmeow Bridge (supervisor no `entrypoint.sh`, recriação de device limpo com `container.NewDevice()`, servidor HTTP antes do dial e retry assíncrono de eventos).

### P3 — Próximos Passos de Engenharia
- [ ] Corrigir contenção de chamadas concorrentes no estado SemiAberto do Circuit Breaker.
- [ ] Propagação de identificador de correlação (Trace ID / Request ID) de ponta a ponta.
- [ ] Exposição de comandos para prompts nomeados persistidos no SQLite.
- [ ] Melhorias de robustez e segurança no scraper de URLs.
