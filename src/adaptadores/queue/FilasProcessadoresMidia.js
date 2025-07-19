// FilasProcessadoresMidia.js

/**
 * FilasProcessadoresMidia - Funções para processamento de mídias
 * 
 * @author Belle Utsch (adaptado por Manel)
 */

const _ = require('lodash/fp');
const { Resultado, Trilho, ArquivoUtils } = require('../../utilitarios/Ferrovia');
const FilasUtilitarios = require('./FilasUtilitarios');

/**
 * ProcessadoresMidia - Funções puras para processamento de mídia
 */
const FilasProcessadoresMidia = {
  /**
   * Processa uma imagem com o modelo de IA
   * @param {Object} gerenciadorAI - Gerenciador de IA
   * @param {Object} registrador - Logger
   * @param {Object} imageData - Dados da imagem
   * @param {string} prompt - Prompt para processamento
   * @param {Object} config - Configurações de processamento
   * @returns {Promise<Resultado>} Resultado do processamento
   */
  processarImagem: _.curry(async (gerenciadorAI, registrador, imageData, prompt, config) => {
    // Validar dados de entrada
    if (!imageData || !imageData.data) {
      return Resultado.falha(new Error("Dados da imagem inválidos ou ausentes"));
    }

    

    // Chamar a função refatorada que retorna Promise<Resultado>
    const resultadoAI = await gerenciadorAI.processarImagem(imageData, prompt, config);

    // Não precisamos mais verificar a string de erro aqui,
    // apenas retornamos o Resultado obtido do GerenciadorAI.
    // O log de erro já ocorreu dentro do GerenciadorAI se necessário.
    return resultadoAI;
  }),

  /**
   * Processa um vídeo com o modelo de IA (incluindo upload e análise)
   * @param {Object} gerenciadorAI - Gerenciador de IA
   * @param {Object} registrador - Logger
   * @param {string} caminhoArquivo - Caminho para o arquivo de vídeo
   * @param {string} prompt - Prompt para processamento
   * @param {Object} config - Configurações de processamento
   * @returns {Promise<Resultado>} Resultado do processamento
   */
  processarVideo: _.curry(async (gerenciadorAI, registrador, caminhoArquivo, prompt, config) => {
    

    // Chamar a função refatorada que retorna Promise<Resultado>
    const resultadoAI = await gerenciadorAI.processarVideo(caminhoArquivo, prompt, config);

    // A limpeza do arquivo local agora é feita dentro do GerenciadorAI (no finally)
    // ou no catch do FilasProcessadores se o job falhar.
    // Não precisamos mais limpar aqui.

    // Apenas retornamos o Resultado obtido do GerenciadorAI.
    // O log de erro já ocorreu dentro do GerenciadorAI se necessário.
    // O catch no FilasProcessadores lidará com a falha do job.
    return resultadoAI;
  })
};

module.exports = FilasProcessadoresMidia;
