// FilasUtilitarios.js

/**
 * FilasUtilitarios - Funções puras para operações comuns
 * 
 * @author Belle Utsch (adaptado por Manel)
 */

const crypto = require('crypto');
const _ = require('lodash/fp');
const { Resultado, ArquivoUtils } = require('../../utilitarios/Ferrovia');
const { verificarArquivoExiste, removerArquivo } = ArquivoUtils;

/**
 * Utilitários - Funções puras para operações comuns
 */
const FilasUtilitarios = {
  /**
   * Gera um identificador único
   * @returns {string} Identificador hexadecimal
   */
  gerarId: () => crypto.randomBytes(8).toString('hex'),

  /**
   * Limpa arquivo temporário
   * @param {string} caminhoArquivo - Caminho para o arquivo
   * @returns {Promise<Resultado>} Resultado da operação
   */
  limparArquivo: (caminhoArquivo) => {
    return verificarArquivoExiste(caminhoArquivo)
      .then(resultado => {
        if (!resultado.sucesso) {
          return Resultado.sucesso(false);
        }
        
        // Se arquivo não existe, não é um erro
        if (!resultado.dados) {
          return Resultado.sucesso(false);
        }
        
        // Remover o arquivo
        return removerArquivo(caminhoArquivo);
      });
  },

  /**
   * Obtém uma mensagem de erro amigável
   * @param {string} tipoMidia - Tipo de mídia ('imagem' ou 'video')
   * @param {Error} erro - Objeto de erro
   * @returns {string} Mensagem amigável
   */
  obterMensagemErroAmigavel: _.curry((tipoMidia, erro) => {
    const mensagemErro = String(erro.message).toLowerCase();

    // Mensagens para erros específicos de imagem
    if (tipoMidia === 'imagem') {
      if (mensagemErro.includes('safety') || mensagemErro.includes('blocked'))
        return "Este conteúdo não pôde ser processado por questões de segurança.";

      if (mensagemErro.includes('too large') || mensagemErro.includes('tamanho'))
        return "Essa imagem é um pouco grande demais para eu processar agora. Pode enviar uma versão menor?";
    }

    // Mensagens para erros específicos de vídeo
    if (tipoMidia === 'video') {
      if (mensagemErro.includes('time out') || mensagemErro.includes('tempo'))
        return "Esse vídeo é tão complexo que acabei precisando de mais tempo! Poderia tentar um trecho menor?";

      if (mensagemErro.includes('forbidden') || mensagemErro.includes('403'))
        return "Encontrei um problema no acesso ao seu vídeo. Pode ser que ele seja muito complexo.";
    }

    // Mensagens comuns
    if (mensagemErro.includes('safety') || mensagemErro.includes('blocked'))
      return "Este conteúdo não pôde ser processado por questões de segurança.";

    if (mensagemErro.includes('too large') || mensagemErro.includes('tamanho'))
      return "Esse arquivo é um pouco grande demais para eu processar agora.";

    if (mensagemErro.includes('format') || mensagemErro.includes('mime'))
      return "Hmm, não consegui processar esse formato. Poderia tentar outro?";

    if (mensagemErro.includes('timeout') || mensagemErro.includes('time out'))
      return "Essa mídia é tão complexa que acabei precisando de mais tempo! Poderia tentar novamente?";

    if (mensagemErro.includes('rate limit') || mensagemErro.includes('quota'))
      return "Estou um pouquinho sobrecarregada agora. Podemos tentar daqui a pouco?";

    return "Tive um probleminha para processar essa mídia. Não desiste de mim, tenta de novo mais tarde?";
  }),

  /**
   * Identifica o tipo específico de erro
   * @param {Error} erro - Objeto de erro
   * @returns {string} Tipo de erro
   */
  identificarTipoErro: (erro) => {
    const mensagemErro = String(erro.message).toLowerCase();

    return _.cond([
      [msg => msg.includes('safety') || msg.includes('blocked'), _.constant('safety')],
      [msg => msg.includes('timeout') || msg.includes('time out'), _.constant('timeout')],
      [msg => msg.includes('forbidden') || msg.includes('403'), _.constant('access')],
      [msg => msg.includes('too large') || msg.includes('tamanho'), _.constant('size')],
      [msg => msg.includes('format') || msg.includes('mime'), _.constant('format')],
      [_.stubTrue, _.constant('general')]
    ])(mensagemErro);
  }
};

module.exports = FilasUtilitarios;