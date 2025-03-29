/**
 * ProcessadorDocumento - Lida com o processamento de mensagens contendo documentos textuais (PDF, TXT, HTML, etc.)
 */
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const { exec } = require('child_process'); // Importar exec
const util = require('util'); // Para promisify
const { Resultado } = require('../../../utilitarios/Ferrovia');
const crypto = require('crypto');
const { obterInstrucaoDocumento } = require('../../../config/InstrucoesSistema'); // Importar instrução

const execPromise = util.promisify(exec); // Criar versão Promise de exec

// Mapeamento de extensões para nomes de arquivo temporários (melhora identificação)
const EXTENSOES_MAP = {
  'application/pdf': '.pdf',
  'text/plain': '.txt',
  'text/html': '.html',
  'text/markdown': '.md',
  'text/csv': '.csv',
  'text/xml': '.xml',
  'application/rtf': '.rtf',
  'text/rtf': '.rtf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx' // Adicionar docx
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
    const isDocx = mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

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

      // Obter configurações e prompt ANTES de decidir o fluxo
      const configUsuario = await gerenciadorConfig.obterConfig(chatId);
      const promptUsuario = mensagem.body || null; // Usar legenda como prompt, se houver

      // Configurações base da IA
      const configBaseAI = {
        model: configUsuario.model || "gemini-2.0-flash",
        temperature: configUsuario.temperature || 0.7,
        topK: configUsuario.topK || 1,
        topP: configUsuario.topP || 0.95,
        maxOutputTokens: configUsuario.maxOutputTokens || 2048, // Manter maior para texto
        dadosOrigem: {
          id: chatId,
          nome: mensagem._data.notifyName || mensagem.from,
          tipo: mensagem.id.remote.includes('@g.us') ? 'grupo' : 'usuario'
        }
      };

      let respostaAI;

      // *** NOVO: Fluxo para DOCX usando pandoc ***
      if (isDocx) {
        registrador.info(`[ProcessadorDocumento] Processando DOCX localmente com pandoc.`);
        // 1. Salvar DOCX temporariamente
        const extensao = EXTENSOES_MAP[mimeType] || '.docx';
        const nomeArquivo = `${crypto.randomBytes(16).toString('hex')}${extensao}`;
        caminhoDocTemporario = path.join(os.tmpdir(), nomeArquivo);
        await fs.writeFile(caminhoDocTemporario, dadosAnexo.data, { encoding: 'base64' });
        registrador.debug(`[ProcessadorDocumento] DOCX salvo temporariamente em: ${caminhoDocTemporario}`);

        // 2. Executar pandoc para extrair texto
        let textoExtraido;
        try {
          const { stdout, stderr } = await execPromise(`pandoc "${caminhoDocTemporario}" -t plain`);
          if (stderr) {
            registrador.warn(`[ProcessadorDocumento] Pandoc stderr: ${stderr}`);
          }
          textoExtraido = stdout;
          registrador.info(`[ProcessadorDocumento] Texto extraído do DOCX via pandoc. Tamanho: ${textoExtraido.length}`);
        } catch (pandocError) {
          registrador.error(`[ProcessadorDocumento] Erro ao executar pandoc: ${pandocError.message}`);
          throw new Error(`Falha ao converter DOCX com pandoc: ${pandocError.message}`);
        }

        // 3. Combinar prompt do usuário (se houver) com texto extraído
        const textoParaIA = promptUsuario
          ? `${promptUsuario}\n\n---\n\n${textoExtraido}`
          : textoExtraido;

        // 4. Chamar processarTexto da IA, **explicitamente passando a instrução de documento**
        registrador.info(`[ProcessadorDocumento] Chamando gerenciadorAI.processarTexto para texto extraído do DOCX.`);
        const configParaTextoDocx = {
          ...configBaseAI,
          systemInstruction: obterInstrucaoDocumento() // Definir a instrução correta
        };
        respostaAI = await gerenciadorAI.processarTexto(textoParaIA, configParaTextoDocx);
        // Adicionar prefixo manualmente, pois processarTexto não adiciona
        respostaAI = `📄 *Análise do seu documento (docx):*\n\n${respostaAI}`;

      } else {
        // *** Fluxo existente para outros tipos de documento (PDF, TXT, HTML, etc.) ***
        registrador.info(`[ProcessadorDocumento] Processando ${mimeType} via upload para Google AI.`);
        // 1. Salvar Documento temporariamente
        const extensao = EXTENSOES_MAP[mimeType] || '.tmp';
        const nomeArquivo = `${crypto.randomBytes(16).toString('hex')}${extensao}`;
        caminhoDocTemporario = path.join(os.tmpdir(), nomeArquivo);
        await fs.writeFile(caminhoDocTemporario, dadosAnexo.data, { encoding: 'base64' });
        registrador.debug(`[ProcessadorDocumento] Documento salvo temporariamente em: ${caminhoDocTemporario}`);

        // 2. Chamar o GerenciadorAI (método de upload de arquivo)
        const configUploadAI = {
          ...configBaseAI,
          mimeType: mimeType // Passar o mimetype original para o método de upload
        };
        registrador.info(`[ProcessadorDocumento] Chamando gerenciadorAI.processarDocumentoArquivo para ${caminhoDocTemporario}`);
        respostaAI = await gerenciadorAI.processarDocumentoArquivo(caminhoDocTemporario, promptUsuario, configUploadAI);
      }

      // 5. Enviar resposta (comum a ambos os fluxos)
      const resultadoEnvio = await servicoMensagem.enviarResposta(mensagem, respostaAI);
      if (!resultadoEnvio.sucesso) {
        registrador.error(`[ProcessadorDocumento] Falha ao enviar resposta AI para ${chatId}: ${resultadoEnvio.erro.message}`);
      } else {
        registrador.info(`[ProcessadorDocumento] Resposta da análise do documento enviada para ${chatId}. Método: ${resultadoEnvio.dados.metodoUsado}`);
      }

      return Resultado.sucesso({ resposta: respostaAI });

    } catch (erro) {
      registrador.error(`[ProcessadorDocumento] Erro ao processar documento (${mimeType}) de ${chatId}: ${erro.message}`, erro.stack);
      // Tentar enviar mensagem de erro genérica
      try {
        await servicoMensagem.enviarMensagemDireta(chatId, `❌ Desculpe, ocorreu um erro ao processar o documento (${mimeType}). Tente novamente.`);
      } catch (erroEnvio) {
        registrador.error(`[ProcessadorDocumento] Falha crítica ao tentar notificar erro para ${chatId}: ${erroEnvio.message}`);
      }
      return Resultado.falha(erro);

    } finally {
      // 6. Limpar arquivo temporário (se foi criado)
      if (caminhoDocTemporario) {
        try {
          await fs.unlink(caminhoDocTemporario);
          registrador.debug(`[ProcessadorDocumento] Arquivo temporário removido: ${caminhoDocTemporario}`);
        } catch (erroLimpeza) {
          registrador.warn(`[ProcessadorDocumento] Falha ao remover arquivo temporário ${caminhoDocTemporario}: ${erroLimpeza.message}`);
        }
      }
    }
  };

  return {
    processarMensagemDocumento // Exportar a função renomeada
  };
};

module.exports = criarProcessadorDocumento; // Exportar o criador renomeado
