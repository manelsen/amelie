# Plano de Refatoração: Fortalecer Contratos da Camada de Persistência (NeDB)

**Objetivo:** Refatorar a interação entre a lógica de negócio e a camada de repositórios NeDB para garantir que a comunicação ocorra exclusivamente através de interfaces de domínio bem definidas (Ports), eliminando chamadas diretas a métodos genéricos de acesso a dados e melhorando o desacoplamento, preparando a aplicação para futuras migrações de tecnologia de banco de dados.

**Fases Principais:**

1.  **Definição Explícita das Interfaces (Ports):**
    *   Analisar cada classe de repositório específica (`RepositorioConfiguracao`, `RepositorioPrompts`, `RepositorioTransacoes`, `RepositorioUsuarios`, `RepositorioGrupos`).
    *   Identificar e listar métodos públicos atuais, separando operações de domínio (ex: `criarTransacao`) de métodos genéricos de acesso a dados (`inserir`, `encontrarUm`, etc.).
    *   Definir formalmente a **interface de domínio** para cada repositório, contendo apenas os métodos de domínio.
    *   Documentar essas interfaces (ex: em `memory-bank/systemPatterns.md` ou neste arquivo).

2.  **Refatoração dos Consumidores:**
    *   Localizar todos os locais (`ConfigManager`, `GerenciadorTransacoes`, Comandos, Processadores) que chamam métodos *genéricos* dos repositórios específicos.
    *   Substituir essas chamadas por chamadas aos métodos de *domínio* definidos na Fase 1. (Se um método de domínio necessário não existir, ele será criado na Fase 3).
    *   Garantir tratamento correto do objeto `Resultado` retornado pelos métodos de domínio.

3.  **Refatoração dos Repositórios Específicos (Implementação NeDB):**
    *   Modificar cada classe de repositório específica para expor publicamente *apenas* os métodos de sua interface de domínio definida.
    *   Manter a lógica interna usando os métodos base do `RepositorioNeDB`, mas tornando esses métodos base `protected` ou privados, se possível.
    *   Remover ou tornar privados/protegidos os métodos genéricos que não fazem parte da interface de domínio.

4.  **Revisão do Tratamento de Erros (Ferrovia):**
    *   Garantir que todos os métodos de domínio nos repositórios retornem `Resultado.sucesso` ou `Resultado.falha` consistentemente, tratando erros internos do NeDB.
    *   Revisar o pipeline em `GerenciadorMensagens.js` para assegurar que falhas retornadas pelos repositórios sejam tratadas corretamente pelo `Trilho.encadear`.

5.  **Testes:**
    *   Atualizar testes existentes para usar as novas interfaces de domínio.
    *   Criar testes para novos métodos de domínio.
    *   Realizar testes manuais completos para garantir a funcionalidade.

**Diagrama Conceitual:**

```mermaid
graph LR
    subgraph Antes (Acoplamento Indesejado)
        C1[Consumidor (e.g., GT)] -- Chama --> R1[RepoTransacoesNeDB];
        R1 -- Expõe --> M1[criarTransacao()];
        R1 -- Expõe --> M2[inserir()];
        R1 -- Expõe --> M3[atualizar()];
        R1 -- Expõe --> M4[encontrar()];
        C1 -- Chama --> M2;
        C1 -- Chama --> M3;
        C1 -- Chama --> M4;
    end

    subgraph Depois (Contrato Claro - NeDB)
        C2[Consumidor (e.g., GT)] -- Chama --> I2[Interface IRepositorioTransacoes];
        R2[RepoTransacoesNeDB] -- Implementa --> I2;
        I2 -- Define --> M5[criarTransacao()];
        I2 -- Define --> M6[atualizarStatus()];
        I2 -- Define --> M7[buscarPendentes()];
        R2 -- Usa Internamente --> RB[RepoNeDB Base (inserir, atualizar, encontrar)];
        C2 -- Chama Apenas --> M5;
        C2 -- Chama Apenas --> M6;
        C2 -- Chama Apenas --> M7;
    end

    style Antes fill:#fdd,stroke:#f00
    style Depois fill:#dfd,stroke:#080