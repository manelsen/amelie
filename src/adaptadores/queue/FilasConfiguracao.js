// FilasConfiguracao.js

/**
 * FilasConfiguracao - Funções para gerenciamento de configurações
 * 
 * @author Belle Utsch (adaptado por Manel)
 */

const _ = require('lodash/fp');
const { Resultado } = require('../../utilitarios/Ferrovia');

const {
  obterInstrucaoImagem,
  obterInstrucaoImagemCurta,
  obterInstrucaoVideo,
  obterInstrucaoVideoCurta,
  obterInstrucaoVideoLegenda,
  obterPromptImagem,
  obterPromptImagemCurto,
  obterPromptVideo,
  obterPromptVideoCurto,
  obterPromptVideoLegenda
} = require('../../config/InstrucoesSistema');

/**
 * Configuracao - Funções puras para configuração do sistema
 */
const FilasConfiguracao = {
  /**
   * Cria configuração Redis
   * @returns {Object} Configuração do Redis
   */
  criarConfigRedis: () => ({
    host: process.env.REDIS_HOST || 'localhost',
    port: process.env.REDIS_PORT || 6379
  }),

  /**
   * Cria configuração das filas
   * @param {Object} redisConfig - Configuração do Redis
   * @returns {Object} Configuração de filas
   */
  criarConfigFilas: _.curry((redisConfig) => ({
    redis: redisConfig,
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 30000
      },
      removeOnComplete: true,
      removeOnFail: false
    }
  })),

  /**
   * Obtém configurações para processamento de mídia
   * @param {Object} gerenciadorConfig - Gerenciador de configurações
   * @param {Object} registrador - Logger para registro
   * @param {string} chatId - ID do chat
   * @param {string} tipoMidia - Tipo de mídia
   * @returns {Promise<Resultado>} Configurações
   */
  obterConfig: _.curry(async (gerenciadorConfig, registrador, chatId, tipoMidia) => {
    try {
      const config = await gerenciadorConfig.obterConfig(chatId);

      // Verificação explícita para legenda ativa
      if (config.usarLegenda === true && tipoMidia === 'video') {
        registrador.info(`🎬👂 Usando modo legenda para vídeo no chat ${chatId} (verificado em obterConfig)`);
        config.modoDescricao = 'legenda';
      }

      // Usar composição para selecionar a instrução correta
      const obterInstrucao = _.cond([
        [_.matches({ tipo: 'imagem', modo: 'curto' }), _.constant(obterInstrucaoImagemCurta())],
        [_.matches({ tipo: 'imagem', modo: 'longo' }), _.constant(obterInstrucaoImagem())],
        [_.matches({ tipo: 'video', modo: 'curto' }), _.constant(obterInstrucaoVideoCurta())],
        [_.matches({ tipo: 'video', modo: 'longo' }), _.constant(obterInstrucaoVideo())],
        [_.matches({ tipo: 'video', modo: 'legenda' }), _.constant(obterInstrucaoVideoLegenda())],
        [_.stubTrue, _.constant(null)]
      ]);

      const modoDescricao = config.modoDescricao || 'curto';
      registrador.debug(`Modo de descrição: ${modoDescricao} para ${tipoMidia} no chat ${chatId}`);

      const systemInstructions = obterInstrucao({ tipo: tipoMidia, modo: modoDescricao });

      return Resultado.sucesso({
        temperature: config.temperature || 0.7,
        topK: config.topK || 1,
        topP: config.topP || 0.95,
        maxOutputTokens: config.maxOutputTokens || (tipoMidia === 'video' ? 1024 : 800),
        model: "gemini-2.0-flash",
        systemInstructions,
        modoDescricao,
        usarLegenda: config.usarLegenda
      });
    } catch (erro) {
      registrador.warn(`Erro ao obter configurações: ${erro.message}, usando padrão`);

      // Configuração padrão
      return Resultado.sucesso({
        temperature: 0.9,
        topK: 1,
        topP: 0.95,
        maxOutputTokens: 1024,
        model: "gemini-2.0-flash",
        modoDescricao: 'curto'
      });
    }
  }),

  /**
   * Prepara o prompt do usuário com base no modo
   * @param {Object} registrador - Logger
   * @param {string} tipoMidia - Tipo de mídia
   * @param {string} promptUsuario - Prompt original
   * @param {string} modoDescricao - Modo de descrição
   * @returns {string} Prompt processado
   */
  prepararPrompt: _.curry((registrador, tipoMidia, promptUsuario, modoDescricao) => {
    if (_.isEmpty(promptUsuario)) {
      // Verificação mais explícita para o modo legenda
      if (tipoMidia === 'video' && modoDescricao === 'legenda') {
        registrador.info('🎬👂 Ativando modo LEGENDA para vídeo - acessibilidade para surdos');
        return obterPromptVideoLegenda();
      }

      // Resto do código com o cond original
      return _.cond([
        [_.matches({ tipo: 'imagem', modo: 'longo' }), () => {
          registrador.debug('Usando prompt LONGO para imagem');
          return obterPromptImagem();
        }],
        [_.matches({ tipo: 'imagem', modo: 'curto' }), () => {
          registrador.debug('Usando prompt CURTO para imagem');
          return obterPromptImagemCurto();
        }],
        [_.matches({ tipo: 'video', modo: 'longo' }), () => {
          registrador.debug('Usando prompt LONGO para vídeo');
          return obterPromptVideo();
        }],
        [_.matches({ tipo: 'video', modo: 'curto' }), () => {
          registrador.debug('Usando prompt CURTO para vídeo');
          return obterPromptVideoCurto();
        }],
        [_.matches({ tipo: 'video', modo: 'legenda' }), () => {
          registrador.debug('Usando prompt LEGENDA para vídeo');
          return obterPromptVideoLegenda();
        }],
        [_.stubTrue, _.constant(promptUsuario)]
      ])({ tipo: tipoMidia, modo: modoDescricao });
    }

    return promptUsuario;
  })
};

module.exports = FilasConfiguracao;