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
const { obterInstrucaoDocumento } = require('../../../config/InstrucoesSistema');
const { inicializarProcessamento, gerenciarCicloVidaTransacao } = require('../util/ProcessamentoHelper'); // Importar helpers
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
  // Adicionar gerenciadorTransacoes às dependências
  const { registrador, servicoMensagem, gerenciadorAI, gerenciadorConfig, gerenciadorTransacoes, clienteWhatsApp } = dependencias;

  /**
   * Processa uma mensagem contendo um anexo de documento.
   * @param {Object} dados - Contém a mensagem, chatId, dadosAnexo (com mimetype e data base64).
   * @returns {Promise<Resultado>} Resultado do processamento.
   */
  const processarMensagemDocumento = async (dados) => {
    const { mensagem, chatId, dadosAnexo } = dados;

    // 1. Inicialização Comum (substitui a verificação manual de config e obtenção de usuário)
    const initResult = await inicializarProcessamento(
      { gerenciadorConfig, clienteWhatsApp, registrador }, // Passa dependências necessárias para init
      mensagem,
      chatId,
      'mediaDocumento' // Nome da feature flag na config
    );

    if (!initResult.sucesso) {
      // Se falhou (desabilitado, erro ao obter usuário), retorna o resultado da falha
      // A função inicializarProcessamento já loga o motivo
      return initResult;
    }
    // Extrai dados do sucesso da inicialização
    const { chat, config, remetente } = initResult.dados;

    // 2. Definir a Função Core Específica para Documentos
    const funcaoCoreDocumento = async (transacao) => {
      let caminhoDocTemporario = null;
      const LIMITE_TAMANHO_DOC_BYTES = 20 * 1024 * 1024; // 20 MB
      let mimeType = dadosAnexo?.mimetype;
      const transacaoId = transacao.id; // Obter ID da transação recebida

      try {
        // Tentar inferir mimetype se for octet-stream (ANTES de checar se é DOCX)
        const nomeArquivo = mensagem.filename || mensagem._data?.filename; // Obter nome do arquivo
        if (mimeType === 'application/octet-stream' && nomeArquivo) {
          const extensao = path.extname(nomeArquivo).toLowerCase();
          if (extensao === '.docx') {
            mimeType = MIMETYPE_DOCX;
            registrador.info(`[Docto-${transacaoId}] Mimetype 'octet-stream' inferido como DOCX.`);
          } else {
            const mimeTypeInferidoInline = EXTENSAO_PARA_MIMETYPE_INLINE[extensao];
            if (mimeTypeInferidoInline) {
              registrador.info(`[Docto-${transacaoId}] Mimetype 'octet-stream' inferido como '${mimeTypeInferidoInline}'.`);
              mimeType = mimeTypeInferidoInline;
            } else {
              registrador.warn(`[Docto-${transacaoId}] Mimetype 'octet-stream', tipo não inferido (ext: '${extensao}'). API pode rejeitar.`);
            }
          }
        }

        registrador.info(`[Docto-${transacaoId}] Recebido (Mimetype: ${mimeType}). Verificando método.`);

        // Verificação de tamanho
        const tamanhoBytes = Buffer.from(dadosAnexo.data, 'base64').length;
        if (tamanhoBytes > LIMITE_TAMANHO_DOC_BYTES) {
          const erroMsg = `Documento excede o limite de tamanho de ${LIMITE_TAMANHO_DOC_BYTES / (1024 * 1024)}MB`;
          registrador.warn(`[Docto-${transacaoId}] ${erroMsg} (Tamanho: ${tamanhoBytes} bytes).`);
          await servicoMensagem.enviarResposta(mensagem, `❌ Desculpe, o documento enviado é muito grande (${(tamanhoBytes / (1024 * 1024)).toFixed(1)}MB). O limite atual é de 20MB.`, transacaoId);
          // Retorna falha controlada, não lança erro para o catch geral do lifecycle
          return Resultado.falha(new Error(erroMsg));
        }

        // Obter prompt e config base (config já veio da inicialização)
        const promptUsuario = mensagem.body || null;
        const configUsuario = config; // Reutiliza a config da inicialização

        const configBaseAI = {
          model: configUsuario.model || "gemini-2.0-flash",
          temperature: configUsuario.temperature || 0.7,
          topK: configUsuario.topK || 1,
          topP: configUsuario.topP || 0.95,
          maxOutputTokens: configUsuario.maxOutputTokens || 2048,
          dadosOrigem: { // Usar dados obtidos na inicialização
            id: chat.id._serialized,
            nome: chat.isGroup ? chat.name : remetente.name,
            tipo: chat.isGroup ? 'grupo' : 'usuario',
            remetenteId: mensagem.author || mensagem.from, // Mantém o ID original
            remetenteNome: remetente.name // Usa o nome obtido/criado
          }
        };

        let respostaAI;

        // *** LÓGICA CONDICIONAL: Pandoc para DOCX, Inline para outros ***
        if (mimeType === MIMETYPE_DOCX) {
          registrador.info(`[Docto-${transacaoId}] Mimetype DOCX. Usando extração local com pandoc.`);
          const nomeTemp = `${crypto.randomBytes(16).toString('hex')}.docx`;
          caminhoDocTemporario = path.join(os.tmpdir(), nomeTemp);
          await fs.writeFile(caminhoDocTemporario, dadosAnexo.data, { encoding: 'base64' });

          let textoExtraido;
          try {
            const { stdout, stderr } = await execPromise(`pandoc "${caminhoDocTemporario}" -t plain`);
            if (stderr) {
              registrador.warn(`[Docto-${transacaoId}] Pandoc stderr: ${stderr}`);
            }
            textoExtraido = stdout;
            registrador.info(`[Docto-${transacaoId}] Texto extraído do DOCX via pandoc. Tamanho: ${textoExtraido?.length || 0}`);
            if (!textoExtraido || textoExtraido.trim().length === 0) {
              throw new Error("Pandoc não extraiu texto do DOCX.");
            }
          } catch (pandocError) {
            registrador.error(`[Docto-${transacaoId}] Erro ao executar pandoc: ${pandocError.message}`);
            // Lança erro para ser pego pelo catch desta função core
            throw new Error(`Falha ao extrair texto do DOCX com pandoc: ${pandocError.message}`);
          }

          const textoParaIA = promptUsuario
            ? `${promptUsuario}\n\n---\n\n${textoExtraido}`
            : textoExtraido;

          registrador.info(`[Docto-${transacaoId}] Chamando gerenciadorAI.processarTexto para texto extraído do DOCX.`);
          const configParaTextoDocx = {
            ...configBaseAI,
            systemInstruction: obterInstrucaoDocumento()
          };
          respostaAI = await gerenciadorAI.processarTexto(textoParaIA, configParaTextoDocx);

          // Adicionar prefixo manualmente
          if (typeof respostaAI === 'string' && !respostaAI.startsWith("Desculpe,")) {
             respostaAI = `📄 *Análise do seu documento (docx):*\n\n${respostaAI}`;
          } else if (typeof respostaAI === 'string') {
             registrador.warn(`[Docto-${transacaoId}] Erro retornado por processarTexto (DOCX): ${respostaAI}`);
          } else {
             // Se respostaAI não for string (ex: erro inesperado da IA), tratar como falha
             throw new Error(respostaAI?.message || "Erro inesperado ao processar texto do DOCX");
          }

        } else {
          registrador.info(`[Docto-${transacaoId}] Mimetype ${mimeType}. Tentando processamento INLINE.`);
          const dadosAnexoCorrigido = { ...dadosAnexo, mimetype: mimeType };

          // processarDocumentoInline deve retornar um Resultado
          const resultadoInline = await gerenciadorAI.processarDocumentoInline(
            dadosAnexoCorrigido,
            promptUsuario,
            configBaseAI,
            transacaoId // Passar transacaoId para logs internos da IA
          );

          if (!resultadoInline.sucesso) {
              registrador.warn(`[Docto-${transacaoId}] Falha no processamento Inline: ${resultadoInline.erro.message}`);
              // Tentar enviar a mensagem de erro específica da IA
              await servicoMensagem.enviarResposta(mensagem, resultadoInline.erro.message, transacaoId);
              // Retorna a falha controlada
              return resultadoInline;
          }
          respostaAI = resultadoInline.dados; // A resposta formatada pela IA
        }

        // Verificar se a resposta final (string) indica um erro não capturado antes
        if (typeof respostaAI === 'string' && (respostaAI.includes("não pôde ser processado") || respostaAI.startsWith("Desculpe,"))) {
          registrador.warn(`[Docto-${transacaoId}] Erro final detectado na resposta da IA (Mimetype: ${mimeType}): ${respostaAI}`);
          await servicoMensagem.enviarResposta(mensagem, respostaAI, transacaoId);
          const erroMsg = respostaAI.split('\n\n')[1] || respostaAI;
          return Resultado.falha(new Error(erroMsg));
        }

        // Enviar resposta de sucesso
        const resultadoEnvio = await servicoMensagem.enviarResposta(mensagem, respostaAI, transacaoId);
        if (!resultadoEnvio.sucesso) {
          registrador.error(`[Docto-${transacaoId}] Falha ao enviar resposta AI: ${resultadoEnvio.erro.message}`);
          // Considerar se isso deve ser uma falha da operação core ou apenas um log
        } else {
          registrador.info(`[Docto-${transacaoId}] Resposta da análise enviada.`);
        }

        return Resultado.sucesso({ resposta: respostaAI });

      } catch (erro) {
        // Captura erros lançados dentro da funcaoCore (ex: pandoc, erro inesperado da IA)
        registrador.error(`[Docto-${transacaoId}] Erro na funcaoCoreDocumento: ${erro.message}`, erro.stack);
        // Lança o erro novamente para ser pego pelo catch do gerenciarCicloVidaTransacao
        throw erro;
      } finally {
        // Limpeza do arquivo temporário movida para o finally da funcaoCore
        if (caminhoDocTemporario) {
          try {
            await fs.unlink(caminhoDocTemporario);
            registrador.info(`[Docto-${transacaoId}] Arquivo temporário ${caminhoDocTemporario} removido.`);
          } catch (erroLimpeza) {
            registrador.warn(`[Docto-${transacaoId}] Falha ao remover arquivo temporário DOCX ${caminhoDocTemporario}: ${erroLimpeza.message}`);
          }
        }
      }
    };

    // 3. Gerenciar Transação e Executar Core
    return await gerenciarCicloVidaTransacao(
      { gerenciadorTransacoes, registrador, servicoMensagem }, // Passa dependências para lifecycle
      mensagem,
      chat, // Chat obtido da inicialização
      funcaoCoreDocumento // Passa a função específica
    );

  };

  return {
    processarMensagemDocumento
  };
};

module.exports = criarProcessadorDocumento;
