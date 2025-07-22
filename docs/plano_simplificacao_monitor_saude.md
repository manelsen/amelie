# Plano de Simplificação do MonitorSaude.js

**Data:** 2025-04-27

**Objetivo:** Simplificar drasticamente o `src/monitoramento/MonitorSaude.js` para focar apenas na verificação da atividade do cliente WhatsApp e reiniciar o processo via `pm2 restart all` em caso de inatividade.

## Decisões

*   **Indicador de Atividade:** A propriedade `clienteWhatsApp.pronto` será usada como o único indicador para verificar se o WhatsApp está ativo.
*   **Intervalo de Verificação:** O status será verificado a cada 60 segundos (60000 ms).
*   **Ação em Caso de Inatividade:** Se `clienteWhatsApp.pronto` for `false`, o comando `pm2 restart all` será executado.

## Passos de Implementação

1.  **Remover Código Desnecessário:** Eliminar todas as funções e lógicas do `src/monitoramento/MonitorSaude.js` relacionadas a:
    *   Monitoramento de memória.
    *   Watchdogs interno e secundário.
    *   Recuperação de emergência complexa (incluindo salvamento de estado crítico e limpeza de arquivos do Chrome).
    *   Recuperação segura de transações.
    *   Verificações complexas de conexão (ex: `verificarChromeVivo`, `verificarMensagensRecentes`).
    *   Funções auxiliares não essenciais (ex: `formatarTempoAtivo`).

2.  **Manter Estrutura Básica:** Preservar as funções `criar`, `iniciar` e `parar` no módulo.

3.  **Implementar Lógica Central Simplificada:**
    *   Na função `criar`: Manter a inicialização básica do estado, recebendo `registrador` e `clienteWhatsApp`.
    *   Na função `iniciar`:
        *   Limpar qualquer intervalo anterior.
        *   Configurar um `setInterval` para executar uma função `verificarEstado` a cada 60000 ms.
        *   Armazenar a referência do intervalo no estado.
    *   Criar a função `verificarEstado`:
        *   Acessar `clienteWhatsApp` a partir do estado.
        *   Verificar `if (!clienteWhatsApp || !clienteWhatsApp.pronto)`.
        *   **Se `true` (inativo):**
            *   Registrar um log de erro (ex: `[MonitorSaude] WhatsApp inativo! Reiniciando via pm2...`).
            *   Executar `require('child_process').execSync('pm2 restart all');` (envolver em `try...catch` para logar possíveis erros na execução do comando).
        *   **Se `false` (ativo):**
            *   (Opcional) Registrar um log informativo (ex: `[MonitorSaude] WhatsApp ativo.`). Considerar logar apenas na transição de inativo para ativo para reduzir ruído.
    *   Na função `parar`:
        *   Limpar o `setInterval` usando a referência armazenada no estado.
        *   Registrar um log informando que o monitor foi parado.

## Fluxo Simplificado (Mermaid)

```mermaid
graph TD
    A[Iniciar MonitorSaude] --> B{setInterval(verificarEstado, 60000ms)};
    B --> C{Verificar clienteWhatsApp.pronto};
    C -- pronto === true --> D[Log: WhatsApp OK (Opcional)];
    D --> B;
    C -- pronto === false --> E[Log: WhatsApp INATIVO! Reiniciando...];
    E --> F[Executar 'pm2 restart all'];
    F --> G[Processo Reinicia];