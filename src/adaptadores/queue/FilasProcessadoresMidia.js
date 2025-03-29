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
  processarImagem: _.curry((gerenciadorAI, registrador, imageData, prompt, config) => {
    // Validar dados de entrada
    if (!imageData || !imageData.data) {
      return Promise.resolve(Resultado.falha(new Error("Dados da imagem inválidos ou ausentes")));
    }
    
    registrador.debug(`Delegando processamento da imagem para gerenciadorAI.processarImagem com modo ${config.modoDescricao}`);

    // Delegar diretamente para a função processarImagem do adaptadorAI refatorado
    // A função gerenciadorAI.processarImagem já lida com:
    // - Obtenção/criação do modelo
    // - Construção das partes do conteúdo
    // - Chamada à API com resiliência (timeout, retry, circuit breaker)
    // - Tratamento de erros (incluindo safety)
    // - Limpeza da resposta
    // - Cache e Rate Limiting
    return Trilho.dePromise(gerenciadorAI.processarImagem(imageData, prompt, config))
      .then(respostaOuErro => {
        // A função processarImagem retorna a string de resposta ou uma string de erro
        // Precisamos verificar se é uma mensagem de erro padrão para retornar falha
        if (typeof respostaOuErro === 'string' && (respostaOuErro.startsWith("Desculpe,") || respostaOuErro.startsWith("Este conteúdo"))) {
          registrador.warn(`[FilasProcessadoresMidia] Erro retornado por gerenciadorAI.processarImagem: ${respostaOuErro}`);
          return Resultado.falha(new Error(respostaOuErro)); // Retorna falha com a mensagem de erro
        }
        // Se não for erro, é a resposta de sucesso
        return Resultado.sucesso(respostaOuErro);
      });
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
  processarVideo: _.curry((gerenciadorAI, registrador, caminhoArquivo, prompt, config) => {
    registrador.debug(`Delegando processamento do vídeo ${caminhoArquivo} para gerenciadorAI.processarVideo`);

    // Delegar diretamente para a função processarVideo do adaptadorAI refatorado
    // A função gerenciadorAI.processarVideo já lida com:
    // - Upload, espera, análise, limpeza de arquivos Google
    // - Chamada à API com resiliência (timeout, retry, circuit breaker)
    // - Tratamento de erros (incluindo safety)
    // - Limpeza da resposta
    // - Cache e Rate Limiting
    return Trilho.dePromise(gerenciadorAI.processarVideo(caminhoArquivo, prompt, config))
      .then(respostaOuErro => {
        // A função processarVideo retorna a string de resposta ou uma string de erro
        if (typeof respostaOuErro === 'string' && (respostaOuErro.startsWith("Desculpe,") || respostaOuErro.startsWith("Este conteúdo"))) {
          registrador.warn(`[FilasProcessadoresMidia] Erro retornado por gerenciadorAI.processarVideo: ${respostaOuErro}`);
          // Limpar arquivo local em caso de erro retornado pelo adaptador
          FilasUtilitarios.limparArquivo(caminhoArquivo);
          return Resultado.falha(new Error(respostaOuErro));
        }
        // Limpar arquivo local em caso de sucesso também (já foi processado)
        FilasUtilitarios.limparArquivo(caminhoArquivo);
        return Resultado.sucesso(respostaOuErro);
      })
      .catch(erro => {
         // Captura erros inesperados durante a chamada ao adaptador
         registrador.error(`[FilasProcessadoresMidia] Erro GERAL ao chamar gerenciadorAI.processarVideo: ${erro.message}`, erro);
         FilasUtilitarios.limparArquivo(caminhoArquivo); // Garante limpeza
         return Resultado.falha(erro);
      });
  })
};

module.exports = FilasProcessadoresMidia;
