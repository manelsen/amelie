/**
 * ProcessadorDocumento - Lida com o processamento de mensagens contendo documentos textuais (PDF, TXT, HTML, etc.)
 */
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const { Resultado } = require('../../../utilitarios/Ferrovia');
const crypto = require('crypto');

// Mapeamento de extensões para nomes de arquivo temporários (melhora identificação)
const EXTENSOES_MAP = {
  'application/pdf': '.pdf',
  'text/plain': '.txt',
  'text/html': '.html',
  'text/markdown': '.md',
  'text/csv': '.csv',
  'text/xml': '.xml',
  'application/rtf': '.rtf',
  'text/rtf': '.rtf'
};

const criarProcessadorDocumento = (dependencias) => {
  const { registrador, servicoMensagem, gerenciadorAI, gerenciadorConfig } = dependencias;

  /**
   * Processa uma mensagem contendo um anexo de documento.
   * @param {Object} dados - Contém a mensagem, chatId, dadosAnexo (com mimetype e data base64).
   * @returns {Promise<Resultado>} Resultado do processamento.
   */
  const processarMensagemDocumento = async (dados) => {
    const { mensagem, chatId, dadosAnexo } = dados;
    let caminhoDocTemporario = null;
    const LIMITE_TAMANHO_DOC_BYTES = 20 * 1024 * 1024; // 20 MB (mantido)
    const mimeType = dadosAnexo.mimetype; // Obter o mimetype real

    try {
      registrador.info(`[ProcessadorDocumento] Recebido documento (${mimeType}) de ${chatId}. Iniciando processamento.`);

      // Verificação de tamanho
      const tamanhoBytes = Buffer.from(dadosAnexo.data, 'base64').length;
      registrador.debug(`[ProcessadorDocumento] Tamanho do documento: ${tamanhoBytes} bytes.`);

      if (tamanhoBytes > LIMITE_TAMANHO_DOC_BYTES) {
        registrador.warn(`[ProcessadorDocumento] Documento (${mimeType}) de ${chatId} excede o limite de ${LIMITE_TAMANHO_DOC_BYTES / (1024 * 1024)}MB. Tamanho: ${tamanhoBytes} bytes.`);
        await servicoMensagem.enviarMensagemDireta(chatId, `❌ Desculpe, o documento enviado é muito grande (${(tamanhoBytes / (1024 * 1024)).toFixed(1)}MB). O limite atual é de 20MB.`);
        return Resultado.falha(new Error(`Documento excede o limite de tamanho de ${LIMITE_TAMANHO_DOC_BYTES} bytes`));
      }

      // 1. Salvar Documento temporariamente
      const extensao = EXTENSOES_MAP[mimeType] || '.tmp'; // Usar extensão correta ou .tmp
      const nomeArquivo = `${crypto.randomBytes(16).toString('hex')}${extensao}`;
      caminhoDocTemporario = path.join(os.tmpdir(), nomeArquivo);
      await fs.writeFile(caminhoDocTemporario, dadosAnexo.data, { encoding: 'base64' });
      registrador.debug(`[ProcessadorDocumento] Documento salvo temporariamente em: ${caminhoDocTemporario}`);

      // 2. Obter configurações e prompt
      const configUsuario = await gerenciadorConfig.obterConfig(chatId);
      const promptUsuario = mensagem.body || null; // Usar legenda como prompt, se houver

      // 3. Chamar o GerenciadorAI (usando o método generalizado que será criado)
      const configAI = {
        model: configUsuario.model || "gemini-2.0-flash",
        temperature: configUsuario.temperature || 0.7,
        topK: configUsuario.topK || 1,
        topP: configUsuario.topP || 0.95,
        maxOutputTokens: configUsuario.maxOutputTokens || 2048,
        mimeType: mimeType, // Passar o mimetype correto
        dadosOrigem: {
          id: chatId,
          nome: mensagem._data.notifyName || mensagem.from,
          tipo: mensagem.id.remote.includes('@g.us') ? 'grupo' : 'usuario'
        }
      };

      // Usaremos 'processarDocumentoArquivo' que será o nome do método generalizado em GerenciadorAI
      registrador.info(`[ProcessadorDocumento] Chamando gerenciadorAI.processarDocumentoArquivo para ${caminhoDocTemporario}`);
      const respostaAI = await gerenciadorAI.processarDocumentoArquivo(caminhoDocTemporario, promptUsuario, configAI);

      // 4. Enviar resposta
      const resultadoEnvio = await servicoMensagem.enviarResposta(mensagem, respostaAI);
      if (!resultadoEnvio.sucesso) {
        registrador.error(`[ProcessadorDocumento] Falha ao enviar resposta AI para ${chatId}: ${resultadoEnvio.erro.message}`);
      } else {
        registrador.info(`[ProcessadorDocumento] Resposta da análise do documento enviada para ${chatId}. Método: ${resultadoEnvio.dados.metodoUsado}`);
      }

      return Resultado.sucesso({ resposta: respostaAI });

    } catch (erro) {
      registrador.error(`[ProcessadorDocumento] Erro ao processar documento (${mimeType}) de ${chatId}: ${erro.message}`, erro.stack);
      try {
        await servicoMensagem.enviarMensagemDireta(chatId, `❌ Desculpe, não consegui processar o documento (${mimeType}). Tente novamente.`);
      } catch (erroEnvio) {
        registrador.error(`[ProcessadorDocumento] Falha crítica ao tentar notificar erro para ${chatId}: ${erroEnvio.message}`);
      }
      return Resultado.falha(erro);

    } finally {
      // 5. Limpar arquivo temporário
      if (caminhoDocTemporario) {
        try {
          await fs.unlink(caminhoDocTemporario);
          registrador.debug(`[ProcessadorDocumento] Arquivo de documento temporário removido: ${caminhoDocTemporario}`);
        } catch (erroLimpeza) {
          registrador.warn(`[ProcessadorDocumento] Falha ao remover arquivo de documento temporário ${caminhoDocTemporario}: ${erroLimpeza.message}`);
        }
      }
    }
  };

  return {
    processarMensagemDocumento // Exportar a função renomeada
  };
};

module.exports = criarProcessadorDocumento; // Exportar o criador renomeado
