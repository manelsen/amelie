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

// Importar processadores
const criarProcessadorTexto = require('./processadores/ProcessadorTexto');
const criarProcessadorComandos = require('./processadores/ProcessadorComandos');
const criarProcessadorAudio = require('./processadores/ProcessadorAudio');
const criarProcessadorImagem = require('./processadores/ProcessadorImagem');
const criarProcessadorVideo = require('./processadores/ProcessadorVideo');
const criarProcessadorMidia = require('./processadores/ProcessadorMidia');

// Importar utilitários
const criarGerenciadorCache = require('./util/CacheMensagens');

// Importar gerenciador de comandos
const criarRegistroComandos = require('./comandos/RegistroComandos');

/**
 * Função principal para criar o gerenciador
 */
const criarGerenciadorMensagens = (dependencias) => {
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
  
  // AQUI ESTÁ A MUDANÇA NA ORDEM DE CRIAÇÃO 🌟
  // Primeiro criamos os processadores específicos
  const processadorAudio = criarProcessadorAudio({
    ...dependencias,
    adaptadorIA
  });
  
  const processadorImagem = criarProcessadorImagem({
    ...dependencias,
    adaptadorIA
  });
  
  const processadorVideo = criarProcessadorVideo({
    ...dependencias,
    adaptadorIA
  });
  
  // Agora sim criamos o processador de mídia injetando os processadores específicos
  const processadorMidia = criarProcessadorMidia({
    ...dependencias,
    adaptadorIA,
    processadorAudio,
    processadorImagem,
    processadorVideo
  });
  
  // Criar processador de texto e comandos normalmente
  const processadorTexto = criarProcessadorTexto({
    ...dependencias,
    adaptadorIA
  });
  
  const processadorComandos = criarProcessadorComandos({
    ...dependencias,
    registroComandos
  });

  // Direcionar mensagem conforme o tipo
  const direcionarPorTipo = (dados) => {
    const { tipo } = dados;
    
    const mapeadorTipos = {
      'comando': () => processadorComandos.processarComando(dados),
      'midia': () => processadorMidia.processarMensagemComMidia(dados),
      'texto': () => processadorTexto.processarMensagemTexto(dados)
    };
    
    const processador = mapeadorTipos[tipo];
    
    if (!processador) {
      return Resultado.falha(new Error(`Tipo de mensagem desconhecido: ${tipo}`));
    }
    
    return processador();
  };

  // Função principal de processamento de mensagens usando composição funcional
  const processarMensagem = async (mensagem) => {
    try {
      // Pipeline de processamento usando Railway Pattern
      const resultado = await Trilho.encadear(
        // Etapa 1: Validação e verificação de duplicação
        () => validarMensagem(registrador, gerenciadorCache.cache, mensagem),
        
        // Etapa 2: Verificar se é mensagem de sistema
        dados => verificarMensagemSistema(registrador, dados),
        
        // Etapa 3: Obter informações do chat
        dados => obterInformacoesChat(registrador, dados),
        
        // Etapa 4: Verificar se deve responder em grupo
        dados => {
          if (dados.ehGrupo) {
            return verificarRespostaGrupo(clienteWhatsApp, dados);
          }
          return Resultado.sucesso(dados);
        },
        
        // Etapa 5: Classificar tipo de mensagem
        dados => verificarTipoMensagem(registrador, dados),
        
        // Etapa 6: Processar conforme o tipo
        dados => direcionarPorTipo(dados)
      )();
      
      // Tratar resultado
      return resultado.sucesso;
    } catch (erro) {
      // Tratar e registrar erro global
      const mensagemId = mensagem?.id?._serialized || 'desconhecido';

      // Classificar tipos de erro para tratamento adequado
      if (erro.message === "Mensagem duplicada" ||
          erro.message === "Mensagem de sistema" ||
          erro.message === "Não atende critérios para resposta em grupo" ||
          erro.message === "Transcrição de áudio desabilitada" ||
          erro.message === "Descrição de imagem desabilitada" ||
          erro.message === "Descrição de vídeo desabilitada") {
        // Erros esperados e tratados silenciosamente
        return false;
      }

      registrador.error(`Erro ao processar mensagem ${mensagemId}: ${erro.message}`);
      return false;
    }
  };

  // Processamento de eventos de entrada em grupo
  const processarEntradaGrupo = async (notificacao) => {
    try {
      if (notificacao.recipientIds.includes(clienteWhatsApp.cliente.info.wid._serialized)) {
        const chat = await notificacao.getChat();

        const BOT_NAME = process.env.BOT_NAME || 'Amélie';
        const LINK_GRUPO_OFICIAL = process.env.LINK_GRUPO_OFICIAL || 'https://chat.whatsapp.com/C0Ys7pQ6lZH5zqDD9A8cLp';

        // Obter texto de ajuda com os comandos disponíveis
        const comandos = registroComandos.listarComandos();
        const listaComandos = comandos
          .map(cmd => `.${cmd.nome} - ${cmd.descricao}`)
          .join('\n\n');

        const textoAjuda = `Olá! Eu sou a Amélie, sua assistente de AI multimídia acessível integrada ao WhatsApp.
Esses são meus comandos disponíveis para configuração.

Use com um ponto antes da palavra de comando, sem espaço, e todas as letras são minúsculas.

Comandos:

${listaComandos}

Minha idealizadora é a Belle Utsch. 
Se quiser conhecer, fala com ela em https://beacons.ai/belleutsch
Quer entrar no grupo oficial da Amélie? O link é ${LINK_GRUPO_OFICIAL}
Meu repositório fica em https://github.com/manelsen/amelie`;

        // Enviar mensagem de boas-vindas
        await chat.sendMessage('Olá a todos! Estou aqui para ajudar. Aqui estão alguns comandos que vocês podem usar:');
        await chat.sendMessage(textoAjuda);

        registrador.info(`Bot foi adicionado ao grupo "${chat.name}" (${chat.id._serialized}) e enviou a saudação.`);
        return Resultado.sucesso(true);
      }

      return Resultado.sucesso(false);
    } catch (erro) {
      registrador.error(`Erro ao processar entrada em grupo: ${erro.message}`);
      return Resultado.falha(erro);
    }
  };

  // Recuperação de transações
  const recuperarTransacao = async (transacao) => {
    try {
      registrador.info(`⏱️ Recuperando transação ${transacao.id} após reinicialização`);

      if (!transacao.dadosRecuperacao || !transacao.resposta) {
        registrador.warn(`Transação ${transacao.id} não possui dados suficientes para recuperação`);
        return Resultado.falha(new Error("Dados insuficientes para recuperação"));
      }

      const { remetenteId, chatId } = transacao.dadosRecuperacao;

      if (!remetenteId || !chatId) {
        registrador.warn(`Dados insuficientes para recuperar transação ${transacao.id}`);
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

      registrador.info(`✅ Transação ${transacao.id} recuperada e entregue com sucesso!`);
      return Resultado.sucesso(true);
    } catch (erro) {
      registrador.error(`Falha na recuperação da transação ${transacao.id}: ${erro.message}`);
      return Resultado.falha(erro);
    }
  };

  // Configuração de callbacks para filas de mídia
  const configurarCallbacksFilas = () => {
    filasMidia.setCallbackRespostaUnificado(async (resultado) => {
      try {
        // Verificação básica do resultado recebido
        if (!resultado || !resultado.senderNumber) {
          registrador.warn("Resultado de fila inválido ou incompleto");
          return;
        }

        const { resposta, senderNumber, transacaoId, remetenteName } = resultado;

        // Usar o ServicoMensagem para enviar
        const resultadoEnvio = await servicoMensagem.enviarMensagemDireta(
          senderNumber,
          resposta,
          {
            transacaoId,
            remetenteName,
            tipoMidia: resultado.tipo || 'desconhecido'
          }
        );

        if (!resultadoEnvio.sucesso) {
          registrador.error(`Erro ao enviar resultado de mídia: ${resultadoEnvio.erro.message}`);
        }
      } catch (erro) {
        registrador.error(`Erro ao processar resultado de fila: ${erro.message}`);
      }
    });

    registrador.info('📬 Callback unificado de filas de mídia configurado com sucesso');
  };

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

    registrador.info('🚀 GerenciadorMensagens inicializado com paradigma funcional');
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