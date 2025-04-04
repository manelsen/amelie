/**
 * GerenciadorMensagens - Módulo para processamento de mensagens do WhatsApp
 * 
 * Implementação refatorada usando programação funcional, padrão Railway e composição com Lodash/FP.
 */

const _ = require('lodash/fp');
const { Resultado, Trilho } = require('../../utilitarios/Ferrovia');
const EventEmitter = require('events');

// Importar módulos de domínio
const criarAdaptadorIA = require('./dominio/AdaptadorIA');
const { validarMensagem, verificarMensagemSistema, verificarTipoMensagem } = require('./dominio/Validadores');
const { obterInformacoesChat, verificarRespostaGrupo } = require('./dominio/OperacoesChat');

// Importar fábrica de processadores
const criarProcessadores = require('./fabricas/FabricaProcessadores');

// Importar utilitários
const criarGerenciadorCache = require('./util/CacheMensagens');

// Importar gerenciador de comandos
const criarRegistroComandos = require('./comandos/RegistroComandos');

/**
 * Função principal para criar o gerenciador
 */
const criarGerenciadorMensagens = (dependencias) => {
  // --- Constantes para mensagens de grupo em Português ---
  const NOME_PADRAO_BOT = 'Amélie';
  const LINK_PADRAO_GRUPO = 'https://chat.whatsapp.com/C0Ys7pQ6lZH5zqDD9A8cLp';
  const MENSAGEM_PADRAO_BOAS_VINDAS = 'Olá a todos! Estou aqui para ajudar. Aqui estão alguns comandos que vocês podem usar:';
  const TEMPLATE_PADRAO_TEXTO_AJUDA =
`Olá! Eu sou a {botName}, sua assistente de AI multimídia acessível integrada ao WhatsApp.
Esses são meus comandos disponíveis para configuração.

Use com um ponto antes da palavra de comando, sem espaço, e todas as letras são minúsculas.

Comandos:

{commandList}

Minha idealizadora é a Belle Utsch. 
Se quiser conhecer, fala com ela em https://beacons.ai/belleutsch
Quer entrar no grupo oficial da Amélie? O link é {groupLink}
Meu repositório fica em https://github.com/manelsen/amelie`;
  // --- Fim das Constantes ---

  const {
    registrador,
    clienteWhatsApp,
    gerenciadorConfig,
    gerenciadorAI,
    filasMidia,
    gerenciadorTransacoes,
    servicoMensagem
  } = dependencias;

  // Verificar se as dependências essenciais foram fornecidas
  if (!registrador || !clienteWhatsApp || !gerenciadorConfig || !gerenciadorAI || !gerenciadorTransacoes || !servicoMensagem || !filasMidia) {
    throw new Error("Dependências essenciais não fornecidas");
  }

  // Criar adaptador para isolar chamadas à IA
  const adaptadorIA = criarAdaptadorIA(registrador, gerenciadorAI);
  
  // Criar gerenciador de cache
  const gerenciadorCache = criarGerenciadorCache(registrador);
  
  // Criar registro de comandos
  const registroComandos = criarRegistroComandos(dependencias);

  // Criar todos os processadores usando a fábrica
  const processadores = criarProcessadores({
    ...dependencias, // Passa todas as dependências originais
    adaptadorIA,     // Passa o adaptadorIA criado aqui
    registroComandos // Passa o registroComandos criado aqui
  });

  // Direcionar mensagem conforme o tipo usando os processadores da fábrica
  const direcionarPorTipo = (dados) => {
    const { tipo } = dados;

    // Usar os processadores retornados pela fábrica
    const mapeadorTipos = {
      'comando': () => processadores.processadorComandos.processarComando(dados),
      'midia': () => processadores.processadorMidia.processarMensagemComMidia(dados),
      'texto': () => processadores.processadorTexto.processarMensagemTexto(dados)
    };
    
    const processador = mapeadorTipos[tipo];
    
    if (!processador) {
      return Resultado.falha(new Error(`Tipo de mensagem desconhecido: ${tipo}`));
    }
    
    return processador();
  };

  // Função principal de processamento de mensagens usando composição funcional
  const processarMensagem = async (mensagem) => {
    // Objeto de dados inicial para o pipeline, contendo a mensagem
    const dadosIniciais = { mensagem };
    const msgIdLog = mensagem?.id?._serialized || 'ID Desconhecido'; // Para logs de erro

    try {
      // Pipeline de processamento usando Railway Pattern
      const resultado = await Trilho.encadear(
        // Etapa 1: Validação e verificação de duplicação
        (dados) => validarMensagem(registrador, gerenciadorCache.cache, dados.mensagem),

        // Etapa 2: Verificar se é mensagem de sistema
        (dados) => verificarMensagemSistema(registrador, dados),

        // Etapa 3: Obter informações do chat
        (dados) => obterInformacoesChat(registrador, dados), // Adiciona chatId, chat, ehGrupo aos dados

        // Etapa 4: Verificar se deve responder em grupo
        async (dados) => {
          if (dados.ehGrupo) {
            return verificarRespostaGrupo(clienteWhatsApp, dados); // Chama a função que usa deveResponderNoGrupo
          }
          return Resultado.sucesso({ ...dados, deveResponder: true }); // Sempre responde se não for grupo
        },

        // Etapa 5: Classificar tipo de mensagem
        (dados) => verificarTipoMensagem(registrador, registroComandos, dados), // Passa registroComandos e adiciona 'tipo', 'comandoNormalizado'

        // Etapa 6: Processar conforme o tipo
        (dados) => direcionarPorTipo(dados)
      )(dadosIniciais); // Iniciar o pipeline com o objeto de dados inicial

      // Tratar resultado final do pipeline
      if (resultado.sucesso) {
        // Processamento bem-sucedido (ou falha esperada tratada internamente)
        return true;
      } else {
        // Registrar falhas não silenciosas que pararam o trilho
        const erroMsg = resultado.erro.message;
        // Lista de erros esperados que não devem ser logados como erro crítico
        const errosSilenciosos = [
          "Mensagem duplicada",
          "Mensagem de sistema",
          "Não atende critérios para resposta em grupo",
          "Transcrição de áudio desabilitada",
          "Descrição de imagem desabilitada",
          "Descrição de vídeo desabilitada",
          "Tipo de mídia não suportado", // Adicionado erro de mídia
          "Usuário não é administrador do grupo" // Adicionado erro de permissão
          // Adicionar outras falhas esperadas aqui, se necessário
        ];

         // Verificar se a mensagem de erro NÃO CONTÉM nenhuma das strings silenciosas
         // E também não contém o erro de vídeo grande
         const ehErroSilencioso = errosSilenciosos.some(silencioso => erroMsg.includes(silencioso));
         const ehVideoGrande = erroMsg?.includes("Vídeo muito grande");

         if (!ehErroSilencioso && !ehVideoGrande) {
           // Logar apenas erros que não são esperados/configurados
           registrador.error(`[MsgProc] Falha inesperada no pipeline: ${erroMsg}`);
         } else {
            // Opcional: Logar falhas esperadas como 'warn' ou 'info' se desejado para depuração
            // registrador.warn(`[MsgProc] Falha esperada no pipeline: ${erroMsg}`);
         }
         return false; // Indica que o processamento parou devido a uma falha (esperada ou não)
       }
     } catch (erro) {
       // Tratar e registrar erro global inesperado (fora do trilho)
       registrador.error(`[MsgProc] ERRO GLOBAL INESPERADO: ${erro.message}`, erro); // Simplificado
       return false;
     }
  };

  // Processamento de eventos de entrada em grupo
  const processarEntradaGrupo = async (notificacao) => {
    try {
      if (notificacao.recipientIds.includes(clienteWhatsApp.cliente.info.wid._serialized)) {
        const chat = await notificacao.getChat();
        const chatId = chat.id._serialized;

        // Obter configuração específica do chat para pegar o nome do bot correto
        let nomeBot = NOME_PADRAO_BOT; // Começa com o padrão
        try {
          const config = await gerenciadorConfig.obterConfig(chatId);
          // Usa o nome da config se disponível, senão mantém o padrão
          nomeBot = config?.botName || NOME_PADRAO_BOT;
        } catch (erroConfig) {
          registrador.warn(`Não foi possível obter config para ${chatId} em processarEntradaGrupo. Usando nome padrão. Erro: ${erroConfig.message}`);
        }

        // Usar as constantes definidas no início da função
        const linkGrupoOficial = LINK_PADRAO_GRUPO; // Usar constante
        const mensagemBoasVindas = MENSAGEM_PADRAO_BOAS_VINDAS; // Usar constante
        const templateTextoAjuda = TEMPLATE_PADRAO_TEXTO_AJUDA; // Usar constante

        // Obter lista de comandos formatada
        const comandos = registroComandos.listarComandos();
        const listaComandos = comandos
          .map(cmd => `.${cmd.nome} - ${cmd.descricao}`)
          .join('\n\n');

        // Montar texto de ajuda usando o template e as configurações/constantes
        const textoAjuda = templateTextoAjuda
          .replace('{botName}', nomeBot) // Usar nomeBot obtido da config ou padrão
          .replace('{commandList}', listaComandos)
          .replace('{groupLink}', linkGrupoOficial); // Usar constante

        // Enviar mensagem de boas-vindas e ajuda usando as constantes
        await chat.sendMessage(mensagemBoasVindas); // Usar constante
         await chat.sendMessage(textoAjuda);

         registrador.info(`[Grupo] Assistente ${nomeBot} adicionada ao grupo "${chat.name}" (${chatId}).`);
         return Resultado.sucesso(true);
       }

       return Resultado.sucesso(false);
     } catch (erro) {
       registrador.error(`[Grupo] Erro ao processar entrada em grupo: ${erro.message}`);
       return Resultado.falha(erro);
     }
  };

   // Recuperação de transações
   const recuperarTransacao = async (transacao) => {
     try {
       registrador.info(`[Recupera] Recuperando transação.`); // Simplificado (ID na coluna)

       if (!transacao.dadosRecuperacao || !transacao.resposta) {
         registrador.warn(`[Recupera] Dados insuficientes para recuperação.`); // Simplificado (ID na coluna)
         return Resultado.falha(new Error("Dados insuficientes para recuperação"));
       }

       const { remetenteId, chatId } = transacao.dadosRecuperacao;

       if (!remetenteId || !chatId) {
         registrador.warn(`[Recupera] Dados de remetente ou chat ausentes.`); // Simplificado (ID na coluna)
         return Resultado.falha(new Error("Dados de remetente ou chat ausentes"));
       }

      // Enviar mensagem diretamente usando as informações persistidas
      await clienteWhatsApp.enviarMensagem(
        remetenteId,
        transacao.resposta,
        { isRecoveredMessage: true }
      );

      // Marcar como entregue
       await gerenciadorTransacoes.marcarComoEntregue(transacao.id);

       registrador.info(`[Recupera] Transação recuperada e entregue com sucesso!`); // Simplificado (ID na coluna)
       return Resultado.sucesso(true);
     } catch (erro) {
       registrador.error(`[Recupera] Falha na recuperação: ${erro.message}`); // Simplificado (ID na coluna)
       return Resultado.falha(erro);
     }
  };

  // Função auxiliar para processar o resultado da fila de mídia
  const _processarResultadoFilaMidia = async (resultado) => {
     // *** LOG DE ENTRADA NO CALLBACK ***
     // Este log é crucial para saber se esta função está sendo chamada
     registrador.info(`[Callback] INICIANDO CALLBACK para resultado: ${JSON.stringify(resultado)}`);
     let transacaoIdParaLog = resultado?.transacaoId || 'ID_DESCONHECIDO_NA_ENTRADA';

     try {
       // Verificação básica do resultado recebido
       if (!resultado || !resultado.senderNumber || !resultado.transacaoId) {
         registrador.warn(`[Callback] Resultado de fila inválido ou sem ID. Saindo.`); // Simplificado
         return; // Sair se dados essenciais faltam
       }

      // Atualizar ID para logs futuros se estava faltando inicialmente
       transacaoIdParaLog = resultado.transacaoId;
       const { resposta, senderNumber, remetenteName, tipo } = resultado;
       const tipoMidiaStr = tipo || 'mídia'; // Usar 'mídia' como padrão se tipo não vier

       registrador.debug(`[Callback] Processando resultado final para ${tipoMidiaStr}.`); // Simplificado (ID na coluna)

       // *** LOG ANTES DO ENVIO ***
       registrador.debug(`[Callback] Tentando enviar via servicoMensagem.enviarMensagemDireta...`); // Simplificado (ID na coluna)

       // Chamada para o serviço de envio
       const resultadoEnvio = await servicoMensagem.enviarMensagemDireta(
        senderNumber,
        resposta,
        {
          transacaoId: transacaoIdParaLog, // Passar o ID correto
          remetenteName,
          tipoMidia: tipoMidiaStr
        }
       );

       // *** LOG DEPOIS DO ENVIO ***
       registrador.debug(`[Callback] Resultado de enviarMensagemDireta: ${JSON.stringify(resultadoEnvio)}`); // Simplificado (ID na coluna)

       // Checar o resultado do envio
       if (!resultadoEnvio || !resultadoEnvio.sucesso) {
         registrador.error(`[Callback] Erro ao enviar resultado de ${tipoMidiaStr}: ${resultadoEnvio?.erro?.message || 'Erro desconhecido ou resultado inválido do envio'}`); // Simplificado (ID na coluna)
         // A transação deve ser marcada como falha pelo ServicoMensagem ou aqui? Revisar ServicoMensagem.
       } else {
         // *** ESTE É O LOG QUE VOCÊ QUER VER ***
         registrador.info(`[Callback] Resposta de ${tipoMidiaStr} enviada com sucesso.`); // Simplificado (ID na coluna)
       }

     } catch (erro) {
       registrador.error(`[Callback] Erro GERAL ao processar resultado de fila: ${erro.message}`, erro); // Simplificado (ID na coluna)
       // Tentar registrar falha na transação se ocorrer erro GERAL aqui
       if (transacaoIdParaLog && transacaoIdParaLog !== 'ID_DESCONHECIDO_NA_ENTRADA') {
           try {
                await gerenciadorTransacoes.registrarFalhaEntrega(transacaoIdParaLog, `Erro no callback: ${erro.message}`);
           } catch (e) {registrador.error(`[Callback] Falha ao registrar erro de callback na transação: ${e.message}`)} // Simplificado (ID na coluna)
       }
     } finally {
        // *** LOG DE SAÍDA DO CALLBACK ***
        // Este log ajuda a confirmar que o callback terminou, mesmo se houve erro
        registrador.debug(`[Callback] FINALIZANDO CALLBACK.`); // Simplificado (ID na coluna)
     }
  }; // Fim de _processarResultadoFilaMidia

  // Configuração de callbacks para filas de mídia
  // Dentro de src/adaptadores/whatsapp/GerenciadorMensagens.js -> criarGerenciadorMensagens

  // Configuração de callbacks para filas de mídia
  const configurarCallbacksFilas = () => {
    // Usar a função nomeada como callback
    filasMidia.setCallbackRespostaUnificado(_processarResultadoFilaMidia);
    /* O código original do callback foi movido para _processarResultadoFilaMidia
    filasMidia.setCallbackRespostaUnificado(async (resultado) => {
      // *** LOG DE ENTRADA NO CALLBACK ***
      // Este log é crucial para saber se esta função está sendo chamada
    */ // Fim do código original comentado


    registrador.info('[Callback] Callback unificado de filas configurado.'); // Simplificado
  }; // Fim de configurarCallbacksFilas

  // Inicialização do gerenciador
  const iniciar = () => {
    // Iniciar gerenciador de cache
    gerenciadorCache.iniciar();
    
    // Configurar handlers de eventos
    clienteWhatsApp.on('mensagem', processarMensagem);
    clienteWhatsApp.on('entrada_grupo', processarEntradaGrupo);

    // Configurar recuperação de transações
    gerenciadorTransacoes.on('transacao_para_recuperar', recuperarTransacao);

    // Configurar callbacks para filas de mídia
    configurarCallbacksFilas();

    // Recuperação inicial após 10 segundos
    setTimeout(async () => {
       await gerenciadorTransacoes.recuperarTransacoesIncompletas();
     }, 10000);

     registrador.info('[Init] GerenciadorMensagens inicializado.'); // Simplificado
     return true;
   };

  // Registra como handler no cliente
  const registrarComoHandler = (cliente) => {
    cliente.on('mensagem', processarMensagem);
    cliente.on('entrada_grupo', processarEntradaGrupo);
    return true;
  };

  // Retornar objeto do gerenciador com interfaces públicas
  return {
    processarMensagem,
    iniciar,
    registrarComoHandler
  };
};

module.exports = criarGerenciadorMensagens;
