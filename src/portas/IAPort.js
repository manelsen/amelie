/**
 * IAPort - Interface funcional para serviços de IA
 * 
 * Define os contratos que os adaptadores de IA devem implementar para
 * interagir com o núcleo da aplicação.
 * Versão funcional baseada em composição.
 */

const criarIAPort = () => {
  return {
    /**
     * Processa uma entrada de texto e gera uma resposta
     * @param {string} texto - Texto de entrada
     * @param {Object} config - Configurações do processamento
     * @returns {Promise<string>} Texto de resposta
     */
    processarTexto: async (texto, config) => {
      throw new Error("Método processarTexto não implementado");
    },
  
    /**
     * Processa uma imagem e gera uma descrição ou resposta
     * @param {Object} imagemData - Dados da imagem
     * @param {string} prompt - Instruções de processamento
     * @param {Object} config - Configurações do processamento
     * @returns {Promise<string>} Texto de resposta
     */
    processarImagem: async (imagemData, prompt, config) => {
      throw new Error("Método processarImagem não implementado");
    },
  
    /**
     * Processa um áudio e gera uma transcrição ou resposta
     * @param {Object} audioData - Dados do áudio
     * @param {string} audioId - Identificador único do áudio
     * @param {Object} config - Configurações do processamento
     * @returns {Promise<string>} Texto de resposta
     */
    processarAudio: async (audioData, audioId, config) => {
      throw new Error("Método processarAudio não implementado");
    },
  
    /**
     * Processa um vídeo e gera uma descrição ou resposta
     * @param {string} caminhoVideo - Caminho para o arquivo de vídeo
     * @param {string} prompt - Instruções de processamento
     * @param {Object} config - Configurações do processamento
     * @returns {Promise<string>} Texto de resposta
     */
    processarVideo: async (caminhoVideo, prompt, config) => {
      throw new Error("Método processarVideo não implementado");
    },

    /**
     * Processa um documento (PDF, TXT, HTML, etc.) e gera uma resposta
     * @param {string} caminhoDocumento - Caminho para o arquivo do documento
     * @param {string} prompt - Instruções de processamento (pode vir da legenda)
     * @param {Object} config - Configurações do processamento (inclui mimeType)
     * @returns {Promise<string>} Texto de resposta
     */
    processarDocumentoArquivo: async (caminhoDocumento, prompt, config) => {
      throw new Error("Método processarDocumentoArquivo não implementado");
    }
  };
};

module.exports = { criarIAPort };
