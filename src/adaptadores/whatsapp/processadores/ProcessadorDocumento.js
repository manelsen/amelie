/**
 * ProcessadorDocumento - Lida com o processamento de mensagens contendo documentos.
 * Usa extração local com pandoc para DOCX e processamento inline para outros tipos suportados.
 */
// Reintroduzir dependências completas
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { exec } = require('child_process');
const util = require('util');
const { Resultado } = require('../../../utilitarios/Ferrovia');
const { obterInstrucaoDocumento } = require('../../../config/InstrucoesSistema'); // Manter instrução

// Reintroduzir execPromise
const execPromise = util.promisify(exec);

// Mapa de extensões para MimeTypes suportados pela API Gemini Inline (excluindo DOCX)
const EXTENSAO_PARA_MIMETYPE_INLINE = {
  '.pdf': 'application/pdf', // Verificar se PDF inline funciona, senão remover
  '.txt': 'text/plain',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.xml': 'text/xml',
  '.rtf': 'application/rtf',
  '.json': 'application/json',
  '.py': 'text/x-python',
  '.js': 'text/javascript',
  '.java': 'text/x-java-source',
  '.c': 'text/x-c',
  '.cpp': 'text/x-c++',
  '.cs': 'text/x-csharp'
  // DOCX será tratado separadamente
};

// Mimetype específico do DOCX para checagem
const MIMETYPE_DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const criarProcessadorDocumento = (dependencias) => {
  const { registrador, servicoMensagem, gerenciadorAI, gerenciadorConfig } = dependencias;

  /**
   * Processa uma mensagem contendo um anexo de documento.
   * @param {Object} dados - Contém a mensagem, chatId, dadosAnexo (com mimetype e data base64).
   * @returns {Promise<Resultado>} Resultado do processamento.
   */
  const processarMensagemDocumento = async (dados) => {
    const { mensagem, chatId, dadosAnexo } = dados;
    let caminhoDocTemporario = null; // Necessário para DOCX
    const LIMITE_TAMANHO_DOC_BYTES = 20 * 1024 * 1024; // 20 MB (mantido)
    let mimeType = dadosAnexo.mimetype; // Obter o mimetype inicial

    try {
      // Tentar inferir mimetype se for octet-stream (ANTES de checar se é DOCX)
      const nomeArquivo = mensagem.filename || mensagem._data?.filename; // Obter nome do arquivo
      if (mimeType === 'application/octet-stream' && nomeArquivo) {
        const extensao = path.extname(nomeArquivo).toLowerCase();
        // Tentar inferir primeiro para DOCX, depois para inline
        if (extensao === '.docx') {
           mimeType = MIMETYPE_DOCX;
           registrador.info(`[ProcessadorDocumento] Mimetype original 'octet-stream' para '${nomeArquivo}'. Inferido como DOCX.`);
        } else {
            const mimeTypeInferidoInline = EXTENSAO_PARA_MIMETYPE_INLINE[extensao];
            if (mimeTypeInferidoInline) {
              registrador.info(`[ProcessadorDocumento] Mimetype original 'octet-stream' para '${nomeArquivo}'. Inferido como '${mimeTypeInferidoInline}' para processamento inline.`);
              mimeType = mimeTypeInferidoInline;
            } else {
              registrador.warn(`[ProcessadorDocumento] Mimetype 'octet-stream' para '${nomeArquivo}', mas não foi possível inferir um tipo suportado (extensão '${extensao}'). A API pode rejeitar.`);
            }
        }
      }

      registrador.info(`[ProcessadorDocumento] Recebido documento (Mimetype final: ${mimeType}) de ${chatId}. Verificando método de processamento.`);

      // Verificação de tamanho
      const tamanhoBytes = Buffer.from(dadosAnexo.data, 'base64').length;
      registrador.debug(`[ProcessadorDocumento] Tamanho do documento: ${tamanhoBytes} bytes.`);

      if (tamanhoBytes > LIMITE_TAMANHO_DOC_BYTES) {
        registrador.warn(`[ProcessadorDocumento] Documento (${mimeType}) de ${chatId} excede o limite de ${LIMITE_TAMANHO_DOC_BYTES / (1024 * 1024)}MB. Tamanho: ${tamanhoBytes} bytes.`);
        await servicoMensagem.enviarMensagemDireta(chatId, `❌ Desculpe, o documento enviado é muito grande (${(tamanhoBytes / (1024 * 1024)).toFixed(1)}MB). O limite atual é de 20MB.`);
        return Resultado.falha(new Error(`Documento excede o limite de tamanho de ${LIMITE_TAMANHO_DOC_BYTES} bytes`));
      }

      // Obter configurações e prompt
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

      // *** LÓGICA CONDICIONAL: Pandoc para DOCX, Inline para outros ***
      if (mimeType === MIMETYPE_DOCX) {
        // --- Processamento DOCX via Pandoc + processarTexto ---
        registrador.info(`[ProcessadorDocumento] Mimetype é DOCX. Usando extração local com pandoc.`);

        // 1. Salvar DOCX temporariamente
        const nomeTemp = `${crypto.randomBytes(16).toString('hex')}.docx`;
        caminhoDocTemporario = path.join(os.tmpdir(), nomeTemp);
        await fs.writeFile(caminhoDocTemporario, dadosAnexo.data, { encoding: 'base64' });
        registrador.debug(`[ProcessadorDocumento] DOCX salvo temporariamente em: ${caminhoDocTemporario}`);

        // 2. Executar pandoc para extrair texto
        let textoExtraido;
        try {
          registrador.debug(`[ProcessadorDocumento] Executando pandoc para extrair texto de ${caminhoDocTemporario}`);
          const { stdout, stderr } = await execPromise(`pandoc "${caminhoDocTemporario}" -t plain`);
          if (stderr) {
            registrador.warn(`[ProcessadorDocumento] Pandoc stderr ao processar DOCX: ${stderr}`);
          }
          textoExtraido = stdout;
          registrador.info(`[ProcessadorDocumento] Texto extraído do DOCX via pandoc. Tamanho: ${textoExtraido?.length || 0}`);
          if (!textoExtraido || textoExtraido.trim().length === 0) {
             throw new Error("Pandoc não extraiu texto do DOCX.");
          }
        } catch (pandocError) {
          registrador.error(`[ProcessadorDocumento] Erro ao executar pandoc para ${caminhoDocTemporario}: ${pandocError.message}`);
          throw new Error(`Falha ao extrair texto do DOCX com pandoc: ${pandocError.message}`); // Lança erro para o catch principal
        }

        // 3. Combinar prompt do usuário (se houver) com texto extraído
        const textoParaIA = promptUsuario
          ? `${promptUsuario}\n\n---\n\n${textoExtraido}`
          : textoExtraido;

        // 4. Chamar processarTexto da IA
        registrador.info(`[ProcessadorDocumento] Chamando gerenciadorAI.processarTexto para texto extraído do DOCX.`);
        const configParaTextoDocx = {
          ...configBaseAI,
          systemInstruction: obterInstrucaoDocumento() // Usar instrução de documento
        };
        respostaAI = await gerenciadorAI.processarTexto(textoParaIA, configParaTextoDocx);
        // Adicionar prefixo manualmente, pois processarTexto não adiciona
        // Verificar se a resposta da IA já é uma mensagem de erro
         if (!respostaAI.startsWith("Desculpe,")) {
            respostaAI = `📄 *Análise do seu documento (docx):*\n\n${respostaAI}`;
         } else {
            registrador.warn(`[ProcessadorDocumento] Erro retornado por processarTexto para DOCX: ${respostaAI}`);
            // Não adicionar prefixo se for erro
         }

      } else {
        // --- Processamento Inline (para outros tipos) ---
        registrador.info(`[ProcessadorDocumento] Mimetype ${mimeType}. Tentando processamento INLINE.`);

        const dadosAnexoCorrigido = {
          ...dadosAnexo,
          mimetype: mimeType // Usar o mimetype final (original ou inferido)
        };

        respostaAI = await gerenciadorAI.processarDocumentoInline(
          dadosAnexoCorrigido,
          promptUsuario,
          configBaseAI
        );
        // A função processarDocumentoInline já lida com erros e formata a resposta/erro
      }

      // Verificar se a resposta da IA indica um erro (comum a ambos os fluxos)
      if (respostaAI.includes("não pôde ser processado") || respostaAI.startsWith("Desculpe,")) {
         registrador.warn(`[ProcessadorDocumento] Erro retornado pela IA para ${chatId} (Mimetype: ${mimeType}): ${respostaAI}`);
         await servicoMensagem.enviarResposta(mensagem, respostaAI);
         const erroMsg = respostaAI.split('\n\n')[1] || respostaAI;
         return Resultado.falha(new Error(erroMsg));
      }

      // 5. Enviar resposta (se não houve erro da IA)
      const resultadoEnvio = await servicoMensagem.enviarResposta(mensagem, respostaAI);
      if (!resultadoEnvio.sucesso) {
        registrador.error(`[ProcessadorDocumento] Falha ao enviar resposta AI para ${chatId}: ${resultadoEnvio.erro.message}`);
      } else {
        registrador.info(`[ProcessadorDocumento] Resposta da análise do documento enviada para ${chatId}.`);
      }

      return Resultado.sucesso({ resposta: respostaAI });

    } catch (erro) {
      registrador.error(`[ProcessadorDocumento] Erro GERAL ao processar documento (Mimetype: ${mimeType}, Caminho Temp: ${caminhoDocTemporario || 'N/A'}) de ${chatId}: ${erro.message}`, erro.stack);
      try {
        await servicoMensagem.enviarMensagemDireta(chatId, `❌ Desculpe, ocorreu um erro ao processar o documento (${mimeType}). Tente novamente.`);
      } catch (erroEnvio) {
        registrador.error(`[ProcessadorDocumento] Falha crítica ao tentar notificar erro GERAL para ${chatId}: ${erroEnvio.message}`);
      }
      return Resultado.falha(erro);

    } finally {
      // Limpar arquivo temporário APENAS se foi criado (para DOCX)
      if (caminhoDocTemporario) {
        try {
          await fs.unlink(caminhoDocTemporario);
          registrador.debug(`[ProcessadorDocumento] Arquivo temporário DOCX removido: ${caminhoDocTemporario}`);
        } catch (erroLimpeza) {
          registrador.warn(`[ProcessadorDocumento] Falha ao remover arquivo temporário DOCX ${caminhoDocTemporario}: ${erroLimpeza.message}`);
        }
      }
    }
  };

  return {
    processarMensagemDocumento
  };
};

module.exports = criarProcessadorDocumento;
