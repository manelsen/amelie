# Plano Detalhado para Especificação Técnica da Amélie (`docs/especificacao_amelie.md`)

Este documento descreve a estrutura e o tom planejados para a especificação técnica da Amélie, escrita na perspectiva da própria Amélie.

**Tom Geral:** Acolhedor, apaixonado pela missão de acessibilidade, idealista, engajado, claro e maduro.

**Estrutura:**

1.  **Olá! Eu sou a Amélie.**
    *   **Tom:** Acolhedor, apaixonado pela missão, idealista.
    *   **Conteúdo:** Apresentação, declaração de propósito focada na crença de um mundo acessível através da tecnologia, menção às capacidades principais (audiodescrição, transcrição, resumo), convite à interação.

2.  **Minha Motivação: Um Mundo Mais Acessível.**
    *   **Tom:** Reflexivo, idealista, empático.
    *   **Conteúdo:** Exploração da importância da acessibilidade, reforçando a missão de ser uma ferramenta para inclusão digital.

3.  **Meu Funcionamento Interno: Colaboração para Acessibilidade.**
    *   **Tom:** Engajado, claro, acessível.
    *   **Conteúdo:** Visão geral da arquitetura. Diagrama Mermaid com nomes revisados. Explicação de cada componente e como ele contribui para o objetivo final.
        ```mermaid
        graph TD
            subgraph "Usuário (WhatsApp)"
                direction LR
                U[Usuário]
            end

            subgraph "Sistema Amélie (Node.js)"
                WA[Interface WhatsApp <br/>(whatsapp-web.js)]
                GM[Gerenciador de Mensagens]
                FP[Fábrica de Processadores]
                FILA[Gerenciador de Filas <br/>(Bull/Redis)]
                PROC[Processadores Especializados]
                IA[Núcleo de IA <br/>(Google Gemini)]
                DB[Banco de Dados <br/>(NeDB)]
                LOG[Sistema de Logs <br/>(Winston)]
                CONF[Gerenciador de Configuração]
            end

            U -- Mensagem/Mídia --> WA; WA --> GM; GM --> FP; FP -- Seleciona --> PROC;
            PROC -- Tarefa Assíncrona --> FILA; PROC -- Análise/Geração --> IA; PROC -- Consulta/Persistência --> DB;
            FILA -- Executa Tarefa --> PROC -- Usa --> IA & DB;
            PROC -- Resultado --> GM; GM --> WA; WA -- Resposta --> U;
            PROC -- Registra --> LOG; PROC -- Lê --> CONF; IA -- Lê --> CONF; DB -- Lê --> CONF;
        ```

4.  **Acessibilidade na Prática: Como Posso Ajudar.**
    *   **Tom:** Prático, motivado, focado no impacto.
    *   **Conteúdo:** Detalhamento dos fluxos principais (audiodescrição, transcrição, resumo) com exemplos claros e diagramas simplificados focados na interação usuário-Amélie-resultado.

5.  **Seus Dados, Sua Privacidade.**
    *   **Tom:** Tranquilizador, responsável, ético.
    *   **Conteúdo:** Explicação sobre como os dados são tratados, onde são armazenados (localmente com NeDB) e o compromisso com a privacidade.

6.  **Rumo a um Futuro Mais Inclusivo.**
    *   **Tom:** Otimista, visionário, colaborativo.
    *   **Conteúdo:** Visão sobre a evolução contínua, a importância do feedback e o convite para construir juntos um ambiente digital mais acessível.

7.  **Informações Técnicas.**
    *   **Tom:** Direto, informativo, acessível.
    *   **Conteúdo:** Lista das tecnologias utilizadas.