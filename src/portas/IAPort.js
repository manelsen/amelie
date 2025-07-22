/**
 * IAPort - Interface para serviços de IA
 * 
 * Define os contratos que os adaptadores de IA devem implementar para
 * interagir com o núcleo da aplicação.
 */

class IAPort {
    /**
     * Processa uma entrada de texto e gera uma resposta
     * @param {string} texto - Texto de entrada
     * @param {Object} config - Configurações do processamento
     * @returns {Promise<string>} Texto de resposta
     */
    async processarTexto(texto, config) {
      throw new Error("Método processarTexto deve ser implementado pela classe concreta");
    }
  
    /**
     * Processa uma imagem e gera uma descrição ou resposta
     * @param {Object} imagemData - Dados da imagem
     * @param {string} prompt - Instruções de processamento
     * @param {Object} config - Configurações do processamento
     * @returns {Promise<string>} Texto de resposta
     */
    async processarImagem(imagemData, prompt, config) {
      throw new Error("Método processarImagem deve ser implementado pela classe concreta");
    }
  
    /**
     * Processa um áudio e gera uma transcrição ou resposta
     * @param {Object} audioData - Dados do áudio
     * @param {string} audioId - Identificador único do áudio
     * @param {Object} config - Configurações do processamento
     * @returns {Promise<string>} Texto de resposta
     */
    async processarAudio(audioData, audioId, config) {
      throw new Error("Método processarAudio deve ser implementado pela classe concreta");
    }
  
    /**
     * Processa um vídeo e gera uma descrição ou resposta
     * @param {string} caminhoVideo - Caminho para o arquivo de vídeo
     * @param {string} prompt - Instruções de processamento
     * @param {Object} config - Configurações do processamento
     * @returns {Promise<string>} Texto de resposta
     */
    async processarVideo(caminhoVideo, prompt, config) {
      throw new Error("Método processarVideo deve ser implementado pela classe concreta");
    }

    /**
     * Processa um documento (PDF, TXT, HTML, etc.) e gera uma resposta
     * @param {string} caminhoDocumento - Caminho para o arquivo do documento
     * @param {string} prompt - Instruções de processamento (pode vir da legenda)
     * @param {Object} config - Configurações do processamento (inclui mimeType)
     * @returns {Promise<string>} Texto de resposta
     */
    async processarDocumentoArquivo(caminhoDocumento, prompt, config) {
      throw new Error("Método processarDocumentoArquivo deve ser implementado pela classe concreta");
    }
  }
  
  module.exports = IAPort;
