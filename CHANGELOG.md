# Changelog

Todas as mudanças notáveis neste projeto serão documentadas neste arquivo.

O formato é baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.0.0/),
e este projeto adere ao [Versionamento Semântico](https://semver.org/lang/pt-BR/).

## [Unreleased]

### Adicionado
- CI/CD Pipeline com GitHub Actions
- ESLint para linting de código
- Prettier para formatação automática
- Husky para git hooks
- Jest coverage reporting
- Contributing guide

## [1.0.0] - 2025-02-18

### Adicionado
- Sistema de login via Pairing Code (alternativa ao QR Code)
- Sistema de prompts via Markdown (doc-driven)
- Comandos de acessibilidade (.cego, .audio, .video, .imagem)
- Processamento de mídia com filas (Better-Queue)
- Integração com Google Gemini 2.5 Flash Lite
- Suporte a transcrição de áudio
- Suporte a descrição de imagens e vídeos
- Suporte a legendas de vídeo (acessibilidade para Surdos)
- Circuit Breaker para resiliência
- Railway Oriented Programming para tratamento de erros
- Arquitetura hexagonal (Ports & Adapters)
- Docker e Docker Compose
- Testes unitários
- Documentação arquitetural completa

### Alterado
- Migração de classes para Factory Functions
- Refatoração para padrão Railway
- Limpeza de código legado

## [0.1.0] - 2024-12-01

### Adicionado
- Versão inicial do projeto
- Integração básica com WhatsApp via Baileys
- Conexão com Gemini API
- Processamento de mensagens de texto
- README inicial
