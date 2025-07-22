# Plano de Refatoração: Processadores de Mensagens WhatsApp (DRY)

## 1. Introdução

Esta documentação descreve o plano para refatorar os processadores de mensagens do WhatsApp (`src/adaptadores/whatsapp/processadores/`) com o objetivo de aplicar o princípio DRY (Don't Repeat Yourself), reduzindo a duplicação de código e melhorando a manutenibilidade.

A análise inicial dos arquivos `ProcessadorAudio.js` e `ProcessadorImagem.js` revelou padrões de código repetidos em várias áreas.

## 2. Análise: Pontos de Repetição Identificados

Os seguintes blocos de lógica foram identificados como repetidos ou muito similares entre os processadores de mídia (Áudio, Imagem, Vídeo, Documento):

*   **Configuração Inicial:** Obtenção do objeto `chat`, carregamento da configuração específica do chat (`gerenciadorConfig.obterConfig`), verificação se a funcionalidade está habilitada (`config.mediaAudio`, `config.mediaImage`, etc.) e obtenção/criação do usuário remetente (`obterOuCriarUsuario`).
*   **Gerenciamento de Transação:** Criação de uma nova transação (`gerenciadorTransacoes.criarTransacao`), marcação da transação como "processando" (`gerenciadorTransacoes.marcarComoProcessando`) e registro de falhas na transação dentro de blocos `catch` (`gerenciadorTransacoes.registrarFalhaEntrega`).
*   **Estrutura de Tratamento de Erros:** Uso de um bloco `try...catch` principal, log de erros gerais (`registrador.error`), e envio de uma mensagem de erro genérica ao usuário final (`servicoMensagem.enviarResposta`) em caso de falhas inesperadas (com exceções para erros específicos como "desabilitado", "tamanho excedido" ou "segurança").

## 3. Proposta de Refatoração

Propõe-se a criação de funções auxiliares/utilitárias para encapsular a lógica comum:

### 3.1. Função `inicializarProcessamento`

*   **Responsabilidade:** Encapsular a lógica inicial comum a vários processadores.
*   **Parâmetros:** `mensagem`, `chatId`, `nomeFuncionalidade` (string, ex: 'mediaAudio', 'mediaImage').
*   **Retorno:** Um objeto `Resultado` contendo `{ chat, config, remetente }` em caso de sucesso, ou `Resultado.falha` com o erro apropriado (ex: funcionalidade desabilitada, falha ao obter usuário).
*   **Implementação:** Conteria as chamadas para `mensagem.getChat()`, `gerenciadorConfig.obterConfig()`, a verificação `config[nomeFuncionalidade]` e a chamada para `obterOuCriarUsuario`.

### 3.2. Função `gerenciarCicloVidaTransacao`

*   **Responsabilidade:** Gerenciar o ciclo de vida completo de uma transação associada ao processamento de uma mensagem, incluindo criação, marcação de status, execução da lógica principal e tratamento de erros/falhas.
*   **Parâmetros:** `gerenciadorTransacoes`, `registrador`, `servicoMensagem`, `mensagem`, `chat`, `funcaoCore` (função assíncrona que recebe a `transacao` criada e contém a lógica específica do processador).
*   **Retorno:** O `Resultado` da execução da `funcaoCore` ou `Resultado.falha` caso ocorra um erro durante o gerenciamento da transação ou na própria `funcaoCore`.
*   **Implementação:**
    *   Chama `gerenciadorTransacoes.criarTransacao`.
    *   Trata falha na criação (log, mensagem ao usuário, retorna falha).
    *   Se sucesso, armazena `transacaoId`.
    *   Chama `gerenciadorTransacoes.marcarComoProcessando`.
    *   Executa `await funcaoCore(transacao)` dentro de um `try`.
    *   No `catch` geral:
        *   Loga o erro (`registrador.error`).
        *   Chama `gerenciadorTransacoes.registrarFalhaEntrega(transacaoId, erro.message)`.
        *   Envia mensagem de erro genérica ao usuário (`servicoMensagem.enviarResposta`), respeitando as exceções.
        *   Retorna `Resultado.falha(erro)`.
    *   Se `funcaoCore` retornar sucesso, retorna esse resultado.
    *   Se `funcaoCore` retornar falha (tratada internamente por ela), propaga essa falha (o `catch` geral não será acionado para `Resultado.falha` retornado pela `funcaoCore`).

## 4. Exemplo de Uso (Pseudo-código para `ProcessadorAudio`)

```javascript
const criarProcessadorAudio = (dependencias) => {
  const { /* ... dependencias ... */ } = dependencias;

  const processarMensagemAudio = async (dados) => {
    const { mensagem, chatId, dadosAnexo } = dados;

    // 1. Inicialização Comum
    const initResult = await inicializarProcessamento(mensagem, chatId, 'mediaAudio');
    if (!initResult.sucesso) return initResult;
    const { chat, config, remetente } = initResult.dados;

    // 2. Lógica Core específica do Áudio
    const funcaoCoreAudio = async (transacao) => {
        // Verificar tamanho (pode ser movido para cá ou mantido fora se falhar antes da transação)
        const resultadoTamanho = verificarTamanhoAudio(dadosAnexo);
        if (!resultadoTamanho.sucesso) {
             await servicoMensagem.enviarResposta(mensagem, 'Desculpe, só posso processar áudios de até 20MB.');
             return resultadoTamanho; // Falha específica antes da IA
        }

        const hashAudio = crypto.createHash('md5').update(dadosAnexo.data).digest('hex');
        const resultadoIA = await adaptadorIA.processarAudio(dadosAnexo, hashAudio, config);

        if (!resultadoIA.sucesso) {
            // Tratar erro específico da IA (ex: segurança)
            if (resultadoIA.erro?.message?.includes('segurança')) {
                 await servicoMensagem.enviarResposta(mensagem, 'Este conteúdo não pôde ser processado por questões de segurança.', transacao.id);
                 // Não precisa registrar falha na transação aqui, pois o gerenciadorCicloVida fará isso no catch
            }
            // Lançar o erro para ser pego pelo catch do gerenciadorCicloVida
            throw resultadoIA.erro || new Error("Falha no processamento da IA");
        }

        const resposta = resultadoIA.dados;
        await gerenciadorTransacoes.adicionarRespostaTransacao(transacao.id, resposta);
        const resultadoEnvio = await servicoMensagem.enviarResposta(mensagem, resposta, transacao.id);
        // Logar sucesso/falha do envio (o gerenciadorCicloVida não trata falha de *envio*)
        if (!resultadoEnvio.sucesso) {
             registrador.error(`[Audio] Falha reportada por servicoMensagem ao enviar resposta: ${resultadoEnvio.erro?.message}`);
        } else {
             registrador.info(`[Audio] Resposta (transcrição) enviada com sucesso.`);
        }

        return Resultado.sucesso({ transacao, resposta }); // Sucesso da operação core
    };

    // 3. Gerenciar Transação e Executar Core
    return await gerenciarCicloVidaTransacao(
        gerenciadorTransacoes, registrador, servicoMensagem,
        mensagem, chat,
        funcaoCoreAudio // Passa a lógica específica
    );
  };

  return { processarMensagemAudio };
};
```

## 5. Diagrama de Sequência (Simplificado)

```mermaid
sequenceDiagram
    participant Client as Cliente WhatsApp
    participant Processor as Processador (Refatorado)
    participant InitUtil as inicializarProcessamento
    participant TxUtil as gerenciarCicloVidaTransacao
    participant CoreLogic as funcaoCore (Específica)
    participant TxManager as gerenciadorTransacoes
    participant ConfigMgr as gerenciadorConfig
    participant UserUtil as obterOuCriarUsuario
    participant ServiceMsg as servicoMensagem
    participant Logger as registrador

    Client->>Processor: processarMensagem(dados)
    Processor->>InitUtil: inicializarProcessamento(msg, chatId, feature)
    InitUtil->>ConfigMgr: obterConfig(chatId)
    ConfigMgr-->>InitUtil: config
    InitUtil-->>UserUtil: obterOuCriarUsuario(...)
    UserUtil-->>InitUtil: remetente
    alt Feature Habilitada e Usuário OK
        InitUtil-->>Processor: Resultado.sucesso({chat, config, remetente})
        Processor->>TxUtil: gerenciarCicloVidaTransacao(..., funcaoCore)
        TxUtil->>TxManager: criarTransacao(msg, chat)
        TxManager-->>TxUtil: resultadoTransacao
        alt Transação Criada
            TxUtil->>TxManager: marcarComoProcessando(txId)
            TxUtil->>CoreLogic: funcaoCore(transacao)
            Note right of CoreLogic: Lógica específica (IA, Fila, etc.)
            CoreLogic-->>TxUtil: resultadoCore (pode ser sucesso ou falha)
            alt Core Logic Sucesso
                 TxUtil-->>Processor: resultadoCore
            else Core Logic Falha (Erro lançado ou Resultado.falha retornado)
                 Note over TxUtil, Logger: Catch no TxUtil lida com erro lançado
                 TxUtil->>Logger: error(...)
                 TxUtil->>TxManager: registrarFalhaEntrega(txId, erro)
                 TxUtil->>ServiceMsg: enviarResposta(msg, "Erro genérico...")
                 TxUtil-->>Processor: Resultado.falha(erro)
            end
        else Falha ao Criar Transação
            TxUtil->>Logger: error(...)
            TxUtil->>ServiceMsg: enviarResposta(msg, "Erro interno...")
            TxUtil-->>Processor: Resultado.falha(erro)
        end
    else Falha na Inicialização
        InitUtil-->>Processor: Resultado.falha(erro)
    end
    Processor-->>Client: Resultado final