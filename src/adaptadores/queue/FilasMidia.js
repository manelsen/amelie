// FilasMidia.js

/**
 * FilasMidia - Módulo funcional para processamento assíncrono de filas de mídia
 * 
 * Implementa arquitetura funcional pura com composição, padrão Railway e imutabilidade.
 * Sem classes, apenas funções e composição.
 * 
 * @author Belle Utsch (adaptado por Manel)
 */

const _ = require('lodash/fp');
const { Resultado } = require('../../utilitarios/Ferrovia');

// Importar os módulos refatorados
const FilasUtilitarios = require('./FilasUtilitarios');
const FilasConfiguracao = require('./FilasConfiguracao');
const FilasCriadores = require('./FilasCriadores');
const FilasProcessadoresMidia = require('./FilasProcessadoresMidia');
const FilasProcessadores = require('./FilasProcessadores');
const FilasMonitorador = require('./FilasMonitorador');

/**
 * Inicializa o sistema de filas de mídia
 * @param {Object} registrador - Logger para registro
 * @param {Object} gerenciadorAI - Gerenciador de IA
 * @param {Object} gerenciadorConfig - Gerenciador de configurações
 * @param {Object} servicoMensagem - Serviço centralizado de mensagens
 * @returns {Object} Sistema de filas inicializado
 */
const inicializarFilasMidia = (registrador, gerenciadorAI, gerenciadorConfig, servicoMensagem) => {
  registrador.info('✨ Inicializando sistema funcional de filas de mídia...');

  // Criar configuração do Redis
  const redisConfig = FilasConfiguracao.criarConfigRedis();

  // Criar configuração das filas
  const configFilas = FilasConfiguracao.criarConfigFilas(redisConfig);

  // Criar estrutura de filas
  const resultadoFilas = FilasCriadores.criarFilas(configFilas);

  if (!resultadoFilas.sucesso) {
    throw resultadoFilas.erro;
  }

  // Expor componentes internos para testes
  inicializarFilasMidia.Resultado = Resultado;
  inicializarFilasMidia.Utilitarios = FilasUtilitarios;
  inicializarFilasMidia.Configuracao = FilasConfiguracao;
  inicializarFilasMidia.CriadoresFilas = FilasCriadores;
  inicializarFilasMidia.ProcessadoresMidia = FilasProcessadoresMidia;
  inicializarFilasMidia.ProcessadoresFilas = FilasProcessadores;
  inicializarFilasMidia.MonitoradorFilas = FilasMonitorador;

  // Configurar todas as filas com eventos
  const filas = FilasCriadores.configurarTodasFilas(registrador, resultadoFilas.dados);

  // Definir callbacks funcionais padrão usando Railway Pattern
  const criarCallbackPadrao = (tipo) => (resultado) => {
    if (!resultado || !resultado.senderNumber) {
      registrador.warn(`Resultado de fila ${tipo} inválido ou incompleto`);
      return Resultado.falha(new Error(`Dados de resposta ${tipo} incompletos`));
    }

    registrador.debug(`Processando resultado de ${tipo} com callback padrão: ${resultado.transacaoId || 'sem_id'}`);

    // Criar mensagem simulada mais completa
    const mensagemSimulada = {
      from: resultado.senderNumber,
      id: { _serialized: resultado.messageId || `msg_${Date.now()}` },
      body: resultado.userPrompt || '',

      // Método getChat simplificado
      getChat: async () => ({
        id: { _serialized: `${resultado.chatId || resultado.senderNumber}` },
        sendSeen: async () => true,
        isGroup: resultado.chatId ? resultado.chatId.includes('@g.us') : false,
        name: resultado.chatName || 'Chat'
      }),

      // Não implementamos reply - o servicoMensagem lidará com isso
      hasMedia: true,
      type: tipo,

      _data: {
        notifyName: resultado.remetenteName || 'Usuário'
      }
    };

    return servicoMensagem.enviarResposta(mensagemSimulada, resultado.resposta, resultado.transacaoId);
  };

  // Objeto para armazenar callbacks
  const callbacks = {
    imagem: criarCallbackPadrao('imagem'),
    video: criarCallbackPadrao('video')
  };

  // Criar funções utilitárias com contexto
  const notificarErro = FilasProcessadores.criarNotificadorErro(registrador, (resultado) => {
    const callback = callbacks[resultado.tipo];
    if (callback) callback(resultado);
    else registrador.warn(`Sem callback para notificar erro de ${resultado.tipo}`);
  });

  const processarResultado = FilasProcessadores.criarProcessadorResultado(registrador, callbacks);

  // Configurar todos os processadores de fila

  // 1. Processadores de Imagem
  filas.imagem.upload.process('upload-imagem', 20,
    FilasProcessadores.criarProcessadorUploadImagem(registrador, filas, notificarErro));

  filas.imagem.analise.process('analise-imagem', 20,
    FilasProcessadores.criarProcessadorAnaliseImagem(registrador, gerenciadorConfig, gerenciadorAI, processarResultado, notificarErro));

  filas.imagem.principal.process('processar-imagem', 20,
    FilasProcessadores.criarProcessadorPrincipalImagem(registrador, filas, notificarErro));

  // 2. Processadores de Vídeo
  filas.video.upload.process('upload-video', 10,
    FilasProcessadores.criarProcessadorUploadVideo(registrador, gerenciadorAI, filas, notificarErro));
  
  filas.video.processamento.process('processar-video', 10,
    FilasProcessadores.criarProcessadorProcessamentoVideo(registrador, gerenciadorAI, filas, notificarErro));
  
  filas.video.analise.process('analise-video', 10,
    FilasProcessadores.criarProcessadorAnaliseVideo(registrador, gerenciadorConfig, gerenciadorAI, processarResultado, notificarErro));
  
  filas.video.principal.process('processar-video', 10,
    FilasProcessadores.criarProcessadorPrincipalVideo(registrador, filas, notificarErro));
  
  // Limpar tarefas antigas ou problemáticas
  FilasMonitorador.limparTrabalhosPendentes(registrador, filas)
    .catch(erro => registrador.error(`Erro ao limpar trabalhos pendentes: ${erro.message}`));
  
  // Retornar API pública funcionalmente composta
  return {
    // Setters para callbacks
    setCallbackRespostaImagem: (callback) => {
      callbacks.imagem = callback;
      registrador.info('✅ Callback de resposta para imagens configurado');
    },

    setCallbackRespostaVideo: (callback) => {
      callbacks.video = callback;
      registrador.info('✅ Callback de resposta para vídeos configurado');
    },

    setCallbackRespostaUnificado: (callback) => {
      callbacks.imagem = callback;
      callbacks.video = callback;
      registrador.info('✅ Callback de resposta unificado configurado');
    },

    // Adição de trabalhos às filas
    adicionarImagem: async (dados) => {
      return filas.imagem.principal.add('processar-imagem', {
        ...dados,
        tipo: 'imagem'
      });
    },

    adicionarVideo: async (dados) => {
      return filas.video.principal.add('processar-video', {
        ...dados,
        tipo: 'video'
      });
    },

    // Limpeza de filas
    limparFilas: (apenasCompletos = true) =>
      FilasMonitorador.limparFilas(registrador, filas, apenasCompletos),

    limparTrabalhosPendentes: () =>
      FilasMonitorador.limparTrabalhosPendentes(registrador, filas),

    // Finalização e liberação de recursos
    finalizar: () => {
      registrador.info('Sistema de filas de mídia finalizado');
    }
  };
};

// Exportar a função de inicialização
module.exports = inicializarFilasMidia;