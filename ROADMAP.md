# ROADMAP: Amélie Gleam

> Atualizado em 8 de outubro de 2026.

## Visão geral

Amélie é um bot multimodal escrito em Gleam sobre BEAM/Erlang, com um bridge Go
baseado em whatsmeow para integração com WhatsApp. O projeto segue arquitetura
hexagonal: domínio e core puros, contratos em `portas/`, integrações em
`adaptadores/` e coordenação de efeitos em `shell/`.

O projeto já ultrapassou a etapa de paridade básica com o legado. O foco atual é
transformar as funcionalidades existentes em uma operação previsível: sessão do
WhatsApp diagnosticável, concorrência controlada, retries seletivos e cobertura
de integração entre os processos Gleam e Go.

## Estado atual

### 1. Fundação e core ✅

- Domínio tipado para mensagens, ações, mídia, configuração, erros e transações.
- Core funcional puro para validação, comandos, construção de prompts e decisão
  das ações a executar.
- Semântica explícita entre `GerarEEnviar`, que chama IA, e `EnviarResposta`, que
  entrega texto pronto.
- Histórico e configuração por chat persistidos em SQLite.
- Comandos com ou sem ponto, normalização de acentos e configurações de mídia,
  legenda, acessibilidade, tamanho da resposta e modelo.
- Detecção de URLs separadas por whitespace, incluindo links em linha própria.

### 2. IA e resiliência 🟡

- Dispatcher para múltiplos provedores: Google Gemini e OpenRouter.
- Seleção de provedor e modelo por chat.
- `gemini-3.5-flash-lite` como modelo padrão e na compactação de histórico.
- Migração automática de configurações nos padrões antigos
  `gemini-3.8-flash` e `gemini-3.1-flash-lite`; escolhas explícitas por outros modelos são preservadas.
- Processamento de texto, imagem, áudio, vídeo e documentos.
- Upload e polling de arquivos pela Gemini File API.
- Cache de respostas por prompt/modelo com TTL e limite de entradas.
- Retry com backoff exponencial e circuit breaker separado por provedor.
- Exclusão de arquivos remotos mantida fora de retry e circuit breaker por ser
  uma operação best-effort.

### 3. WhatsApp e mídia 🟡

- Bridge Go atualizado para uma versão de agosto de 2026 do whatsmeow, com os
  breaking changes absorvidos.
- Recebimento e envio de mensagens, respostas citadas e reações.
- Suporte a JIDs LID e persistência do dispositivo/sessão pelo whatsmeow.
- Filas OTP independentes para imagem, áudio, vídeo, documento e sticker.
- Media retry para arquivos expirados ou temporariamente indisponíveis.
- Stickers estáticos, animados, thumbnail e fallback textual quando a mídia não
  pode ser recuperada.
- Vídeos enviados como mídia. Links de vídeo (YouTube, Instagram, TikTok)
  recebem um aviso pedindo o arquivo: o download externo foi desativado por
  risco de SSRF.
- Fila persistente entre bridge e webhook Gleam.
- Replay de `HistorySync` desativado no bridge; filtro de idade e deduplicação
  continuam protegendo o handler Gleam.
- Falhas de conexão registradas por evento e propagadas de ponta a ponta:
  whatsmeow → bridge → HTTP estruturado → adaptador Gleam → log da aplicação.
- `/health`, `/send` e `/react` distinguem sessão ausente, logout, desconexão,
  stream substituído, cliente desatualizado, banimento temporário e falha da
  operação.

### 4. Persistência e operação 🟡

- Auditoria de entregas e reações em SQLite.
- Fila offline com limite de tentativas e descarte explícito.
- Registro de mensagens recebidas para deduplicação.
- Limpeza periódica de transações antigas.
- Registro automático de usuários e grupos.
- Executor de snapshot para históricos longos implementado, ainda sem comando ou
  agendamento que o acione.
- Métricas em memória para mensagens, erros e mídia processada, ainda sem endpoint
  ou comando público de consulta.
- Dockerfile multi-stage, Docker Compose, volumes persistentes e rotação de logs.

### 5. Capacidades conectadas e multicanal ✅

- **Telegram 100% Integrado:** Paridade total com o WhatsApp (texto, comandos, fotos em alta resolução, áudio/mensagens de voz, vídeos até 20MB, documentos até 20MB, figurinhas WebP/WebM, chat actions e reações equivalentes), operando com roteamento multicanal sem duplicar lógica de domínio e com descarte rigoroso de grupos.
- **Administração Remota via Telegram (RBAC):** Painel `/status` exibindo saúde de canais (WhatsApp e Telegram), métricas BEAM (memória e contagem de processos) e contadores de mensagens/erros. Comandos administrativos `/reset_whatsapp` e `/parear <numero>` restritos a `TELEGRAM_ADMIN_CHAT_ID`, com entrega automática e proativa do pairing code.
- **Resiliência do Bridge Go:** Supervisor contínuo em `entrypoint.sh`, inicialização imediata do servidor HTTP (`:8080`), recriação de device limpo com `container.NewDevice()` em resets e retries assíncronos na notificação de eventos.
- **Healthcheck Consolidado (`GET /health`):** Estado agregado em tempo real cobrindo SQLite, sessão e conectividade do WhatsApp, status do Telegram e telemetria BEAM.
- Persistência e executores de prompts nomeados implementados no SQLite/shell, aguardando apenas exposição pelo dispatcher de comandos.

## Validação atual

- 175 testes Gleam passando (`gleam test`).
- Testes unitários, race detector, `go vet` e build do bridge Go passando (`go test ./...`).
- Testes de regressão cobrindo Circuit Breaker (estados Fechado/Aberto e contenção única em SemiAberto), classificação e descarte seletivo da fila offline, Telegram (decodificação, mídias, mídias mudas, chat actions, RBAC), comandos de administração, healthcheck consolidado, HistorySync e filas OTP.
- Cobertura de acessibilidade e síntese de voz (TTS): scraper de artigos limpo, sanitização de saídas textuais, audiodescrição estruturada de documentos/boletos/contas/contratos e compactação inteligente de histórico com `.resumo`.

## Próximas prioridades

### P0 — Confiabilidade operacional (Concluído ✅)

- [x] Tornar o estado de sessão do WhatsApp visível no healthcheck da aplicação Gleam (`GET /health`) e no healthcheck do container.
- [x] Resiliência de pareamento e reset de sessão:
  - Inicialização do HTTP server antes do dial do WhatsApp para disponibilidade imediata de `/health`, `/pair-phone` e `/reset-session`.
  - Tratamento de `ErrDeviceDeleted` instanciando novo `whatsmeow.Client` após reset.
  - Eliminação de `log.Fatalf` no timeout de pairing code (timeout gracioso preservando processo).
  - Supervisor contínuo em loop dentro de `entrypoint.sh` para recuperação automática.
  - Retry assíncrono com backoff para eventos notificados ao Gleam (`notifyGleamEvent`).
- [x] Painel administrativo remoto e comando de pareamento proativo via Telegram (`/status`, `/reset_whatsapp`, `/parear`) com controle de acesso por ID.
- [x] Procedimento operacional de backup, restauração e pareamento documentado em `DEPLOYMENT.md`.
- [x] Classificar erros da fila offline em transitórios e definitivos (descarte imediato de `invalid_chat_id`, payloads malformados e sessões revogadas sem esgotar retries desnecessários).
- [x] Teste ponta a ponta em `test/ponta_a_ponta_test.gleam`: JSON da ponte → `whatsmeow_webhook` → receptor → tratador → IA fake → `entrega_auditada` → `whatsmeow_http` → ponte falsa (servidor HTTP real), com SQLite em memória e reenvio pela fila offline.

### P1 — Concorrência e observabilidade

- [x] Corrigir o estado semiaberto do circuit breaker para permitir uma única chamada de prova (`SemiAberto(probe_em_voo: True)` com contenção estrita de requisições concorrentes).
- [x] Adicionar identificadores de correlação (`[trace:id]`) propagados em todos os logs do handler de mensagens e workers das filas de mídia.
- [ ] Avaliar a retirada de `process.call` síncrono do caminho quente do circuit breaker ou medir sua contenção sob carga das filas de mídia.
- [ ] Adicionar métricas de latência e contadores de retry por provedor no coletor de métricas.
- [ ] Definir timeouts por operação externa e propagar a causa original em todos os adaptadores.

### P2 — Multi-canal (Concluído ✅)

- [x] **Etapa 1 (Texto, Comandos e Roteamento Multicanal — Concluída):**
  - Webhook de updates do Telegram (`POST /webhook/telegram`) com validação opcional de secret token.
  - Bloqueio estrito e sistemático de grupos no Telegram (`chat.type != "private"` é descartado).
  - Roteador multicanal (`roteador_mensageiro`) selecionando `MensageiroPorta` por prefixo de `chat_id` (`tg:` vs WhatsApp) sem duplicar core ou handlers.
  - Normalização de comandos com barra (`/start`, `/ajuda`, `/cego`, `/curto`, etc.) e suporte a menção do bot em comandos.
  - Cobertura completa com testes automatizados de decodificação, roteamento e fluxo end-to-end.
- [x] **Etapa 2 (Fotos e Áudio/Voz — Concluída):**
  - Download assíncrono e não-bloqueante de fotos (alta resolução) e áudios/mensagens de voz via Telegram Bot API (`getFile` + `baixar_arquivo`).
  - Suporte a legendas (`caption`) em fotos e áudios integradas ao contexto da mensagem.
  - Encaminhamento direto para as filas OTP existentes em `fila_midia.gleam` e pipeline multimodal do Gemini.
  - Rejeição categórica de mídias recebidas em grupos do Telegram.
- [x] **Etapa 3 (Documentos, Figurinhas, Vídeos até 20MB e Chat Actions — Concluída):**
  - [x] Suporte a vídeos (`video`, `video_note`, `animation` e vídeos enviados como documentos) até 20MB via Bot API com download assíncrono e fila OTP de vídeo.
  - [x] Mapeamento compatível de reações (`⌛`/`⏳` -> `🤔` e `🆗` -> `👍`) com feedback visual imediato ao usuário.
  - [x] Suporte a documentos genéricos (PDFs, TXT, DOCX, etc.) até 20MB integrados à fila OTP de documentos e pipeline multimodal do Gemini.
  - [x] Suporte a figurinhas/stickers estáticos e em vídeo (`image/webp` e `video/webm`) integrados à fila OTP de figurinhas e contexto de emoji associado.
  - [x] Indicadores de presença em tempo real via Telegram Bot API (`sendChatAction` com `typing`, `upload_photo`, `upload_voice`, `upload_video`, `upload_document`, `choose_sticker`).
  - [x] Rejeição categórica de qualquer mídia, documento ou figurinha recebido em grupos do Telegram.

### P3 — Acessibilidade e evolução de produto

- [x] **Acessibilidade para Leitores de Tela / TTS:**
  - Extração limpa de artigos e páginas com remoção de scripts, styles, headers, footers e navegações em `extrator_url`.
  - Sanitização de texto com remoção de poluição visual (linhas de traços repetidos, divisores, suavização de tabelas com pipes, colapso de sequências de emojis) em `acessibilidade`.
  - Análise estruturada de documentos e PDFs (foco prioritário em contas, faturas, boletos, código de barras/PIX copia-e-cola e contratos).
  - Compactação inteligente de histórico e comando `.resumo` / `/resumo` preservando contexto essencial.
- [ ] Decidir se a seleção de modelos antigos/OpenRouter continuará exposta por
  chat ou se produção ficará restrita ao `gemini-3.5-flash-lite`.
- [ ] Adicionar plugins/ferramentas com permissões e limites explícitos.
- [ ] Avaliar modelos locais via Ollama depois de estabilizar observabilidade e
  operação multi-canal.

## Critério para a próxima etapa

A fase de endurecimento operacional estará concluída quando perda de sessão,
falhas temporárias e erros definitivos produzirem comportamentos distintos e
observáveis; quando o fluxo principal estiver coberto por um teste end-to-end; e
quando o circuit breaker e as filas tiverem métricas suficientes para validar seu
comportamento sob concorrência.
