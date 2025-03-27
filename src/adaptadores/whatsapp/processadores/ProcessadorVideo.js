/**
 * ProcessadorVideo - Processamento específico para mensagens com vídeos
 */
const _ = require('lodash/fp');
const { Resultado } = require('../../../utilitarios/Ferrovia'); // Apenas Resultado
const { obterOuCriarUsuario } = require('../dominio/OperacoesChat');
const fs = require('fs');
const path = require('path');
const InstrucoesSistema = require('../../../config/InstrucoesSistema'); // Necessário

const criarProcessadorVideo = (dependencias) => {
  const {
    registrador,
    gerenciadorConfig,
    gerenciadorTransacoes,
    servicoMensagem,
    filasMidia,
    clienteWhatsApp
  } = dependencias;

  // Função helper para verificar tamanho (mantida)
  const verificarTamanhoVideo = _.curry((dadosAnexo, limiteMB = 20) => {
     const tamanhoVideoMB = dadosAnexo.data.length / (1024 * 1024);
     if (tamanhoVideoMB > limiteMB) {
       return Resultado.falha(new Error(`Vídeo muito grande (${tamanhoVideoMB.toFixed(2)}MB). Limite: ${limiteMB}MB`));
     }
     return Resultado.sucesso({ dadosAnexo, tamanhoVideoMB });
   });

  // Função helper para salvar arquivo temporário (mantida, mas poderia ser movida para ArquivoUtils)
  const salvarArquivoTemporario = _.curry(async (dadosAnexo) => {
     try {
       const dataHora = new Date().toISOString().replace(/[:.]/g, '-');
       const arquivoTemporario = `./temp/video_${dataHora}_${Math.floor(Math.random() * 10000)}.mp4`;
       const diretorio = path.dirname(arquivoTemporario);
       await fs.promises.mkdir(diretorio, { recursive: true });
       registrador.debug(`Salvando arquivo de vídeo ${arquivoTemporario}...`);
       const videoBuffer = Buffer.from(dadosAnexo.data, 'base64');
       await fs.promises.writeFile(arquivoTemporario, videoBuffer);
       const stats = await fs.promises.stat(arquivoTemporario);
       if (stats.size !== videoBuffer.length) {
         throw new Error(`Tamanho do arquivo salvo (${stats.size}) não corresponde ao buffer original (${videoBuffer.length})`);
       }
       registrador.debug(`✅ Arquivo de vídeo salvo com sucesso: ${arquivoTemporario} (${Math.round(videoBuffer.length / 1024)} KB)`);
       return Resultado.sucesso(arquivoTemporario);
     } catch (erro) {
       registrador.error(`Erro ao salvar arquivo temporário: ${erro.message}`);
       return Resultado.falha(erro);
     }
   });

  // Função principal de processamento de vídeo
  const processarMensagemVideo = async (dados) => {
    const { mensagem, chatId, dadosAnexo } = dados;
    let arquivoTemporario = null; // Para limpeza em caso de erro
    let currentTransacaoId = null; // Para log no catch e registro de falha
    registrador.debug(`[Video] Iniciando para msg ${mensagem.id._serialized} no chat ${chatId}`);

    try { // Bloco try principal
      // Obter chat
      const chat = await mensagem.getChat();

      // Obter configuração
      registrador.debug(`[Video] Obtendo config para ${chatId}...`);
      const config = await gerenciadorConfig.obterConfig(chatId);
      registrador.debug(`[Video] Config obtida para ${chatId}: mediaVideo=${config?.mediaVideo}, modoDescricao=${config?.modoDescricao}`);

      // Verificar se processamento de vídeo está habilitado
      if (!config || !config.mediaVideo) {
        registrador.info(`[Video] Descrição de vídeo DESABILITADA para ${chatId}. Ignorando.`);
        return Resultado.falha(new Error("Descrição de vídeo desabilitada"));
      }
       registrador.debug(`[Video] Descrição HABILITADA para ${chatId}. Continuando...`);

      // Obter informações do remetente
       registrador.debug(`[Video] Obtendo remetente para ${chatId}...`);
       const resultadoRemetente = await obterOuCriarUsuario(
         gerenciadorConfig,
         clienteWhatsApp,
         registrador
       )(mensagem.author || mensagem.from, chat);

       if (!resultadoRemetente.sucesso) {
         registrador.error(`[Video] Falha ao obter remetente: ${resultadoRemetente.erro?.message}`);
         throw new Error("Falha ao obter remetente");
       }
       const remetente = resultadoRemetente.dados;
       registrador.debug(`[Video] Remetente obtido: ${remetente.name}`);

      // Verificar tamanho do vídeo
      registrador.debug(`[Video] Verificando tamanho do vídeo...`);
      const resultadoTamanho = verificarTamanhoVideo(dadosAnexo);
       if (!resultadoTamanho.sucesso) {
         registrador.warn(`[Video] ${resultadoTamanho.erro.message} recebido de ${remetente.name}.`);
         await servicoMensagem.enviarResposta(
           mensagem,
           resultadoTamanho.erro.message.includes("Limite") // Mensagem mais específica
             ? resultadoTamanho.erro.message
             : 'Desculpe, só posso processar vídeos de até 20MB.'
         );
         return Resultado.falha(resultadoTamanho.erro); // Parar aqui
       }
       registrador.debug(`[Video] Tamanho OK.`);


      // --- Bloco Corrigido de Criação e Verificação da Transação ---
      registrador.debug(`[Video] Criando transação para ${chatId}...`);
      const resultadoTransacao = await gerenciadorTransacoes.criarTransacao(mensagem, chat);
      registrador.debug(`[Video] Resultado de criarTransacao: ${JSON.stringify(resultadoTransacao)}`);

      if (!resultadoTransacao || !resultadoTransacao.sucesso) {
           registrador.error(`[Video] Falha ao criar transação: ${resultadoTransacao?.erro?.message || 'Resultado inválido/inesperado'}`);
           try {
               await servicoMensagem.enviarResposta(mensagem, 'Desculpe, ocorreu um erro interno ao iniciar o processamento.');
           } catch(e) { registrador.error(`[Video] Falha ao enviar erro sobre criarTransacao: ${e.message}`)}
           return Resultado.falha(resultadoTransacao?.erro || new Error("Falha ao criar transação"));
      }

      const transacao = resultadoTransacao.dados;
      registrador.info(`[Video] Transação ${transacao?.id ? 'criada com id' : 'criada sem id (!)'}. ID: ${transacao?.id}`);

      if (!transacao || !transacao.id) {
          registrador.error("[Video] *** ERRO CRÍTICO: Objeto transação ou ID está faltando após criação bem-sucedida! ***");
          try {
              await servicoMensagem.enviarResposta(mensagem, 'Desculpe, ocorreu um erro crítico ao registrar o processamento (ID faltando).');
          } catch(e) { registrador.error(`[Video] Falha ao enviar erro sobre ID faltando: ${e.message}`)}
          return Resultado.falha(new Error("ID da Transação faltando após criação"));
      }

      currentTransacaoId = transacao.id; // Armazena o ID validado
      registrador.debug(`[Video] ID da transação ${currentTransacaoId} validado. Continuando processamento...`);
      // --- Fim do Bloco Corrigido ---


      // Marcar como processando
      await gerenciadorTransacoes.marcarComoProcessando(currentTransacaoId); // Usar ID validado
      registrador.debug(`[Video] Transação ${currentTransacaoId} marcada como processando.`);


      // Determinar prompt do usuário baseado no modo
      let promptUsuario = "";
      if (config.modoDescricao === 'legenda' || config.usarLegenda === true) {
        registrador.info(`[Video] 🎬👂 Aplicando prompt específico para LEGENDAGEM (transação ${currentTransacaoId})`);
        promptUsuario = InstrucoesSistema.obterPromptVideoLegenda(); // Usar função importada
      } else if (mensagem.body && mensagem.body.trim() !== '') {
        promptUsuario = mensagem.body.trim();
      } else if (config.modoDescricao === 'longo') {
        promptUsuario = InstrucoesSistema.obterPromptVideo(); // Usar função importada
      } else {
        promptUsuario = InstrucoesSistema.obterPromptVideoCurto(); // Usar função importada
      }
      registrador.debug(`[Video] Prompt para IA: ${promptUsuario.substring(0,100)}...`);


      // Salvar arquivo temporário
      registrador.debug(`[Video] Salvando arquivo temporário para ${currentTransacaoId}...`);
      const resultadoSalvar = await salvarArquivoTemporario(dadosAnexo);
      if (!resultadoSalvar.sucesso) {
           registrador.error(`[Video] Falha ao salvar arquivo temporário para ${currentTransacaoId}: ${resultadoSalvar.erro.message}`);
           throw new Error("Falha ao salvar arquivo temporário"); // Lançar erro para o catch geral
      }
      arquivoTemporario = resultadoSalvar.dados; // Guardar caminho para limpeza
      registrador.debug(`[Video] Arquivo temporário salvo: ${arquivoTemporario}`);

      // Passar informação de legenda nas opções
      const opcoesAdicionais = {};
      if (config.modoDescricao === 'legenda' || config.usarLegenda === true) {
        opcoesAdicionais.modoLegenda = true;
      }

      // Adicionar vídeo à fila
      registrador.info(`[Video] Adicionando job à fila para ${chatId} com transacaoId: ${currentTransacaoId}`);
      await filasMidia.adicionarVideo({
        tempFilename: arquivoTemporario,
        chatId,
        messageId: mensagem.id._serialized,
        mimeType: dadosAnexo.mimetype,
        userPrompt: promptUsuario,
        senderNumber: mensagem.from,
        transacaoId: currentTransacaoId, // *** PASSANDO A VARIÁVEL CORRETA ***
        remetenteName: remetente.name,
        modoDescricao: config.modoDescricao || 'curto',
        usarLegenda: config.usarLegenda === true,
        ...opcoesAdicionais
      });

      registrador.debug(`[Video] Vídeo de ${remetente.name} adicionado à fila com transacaoId ${currentTransacaoId}`);
      // Não precisa mais limpar arquivo aqui, a fila fará isso após o processamento
      // arquivoTemporario = null; // Resetar para evitar limpeza duplicada no catch

      return Resultado.sucesso({ transacao }); // Retornar o objeto transacao original


    } catch (erro) { // Catch geral
      registrador.error(`[Video] ERRO GERAL para msg ${mensagem?.id?._serialized} / chat ${chatId} / transação ${currentTransacaoId}: ${erro.message}`, erro);

       // Limpar arquivo temporário se foi criado e erro ocorreu antes de ir pra fila com sucesso
       if (arquivoTemporario) {
           try {
               if(fs.existsSync(arquivoTemporario)) {
                  await fs.promises.unlink(arquivoTemporario);
                  registrador.info(`[Video] Arquivo temporário ${arquivoTemporario} removido após erro.`);
               }
           } catch (errUnlink) {
               registrador.error(`[Video] Erro ao remover arquivo temporário ${arquivoTemporario} após erro: ${errUnlink.message}`);
           }
       }

      // Registrar falha na transação se ID existe
       if (currentTransacaoId) {
           try {
               await gerenciadorTransacoes.registrarFalhaEntrega(currentTransacaoId, `Erro processamento vídeo: ${erro.message}`);
           } catch (e) { registrador.error(`[Video] Falha ao registrar erro na transação ${currentTransacaoId}: ${e.message}`); }
       }

      // Enviar feedback genérico de erro, exceto se já foi tratado (tamanho) ou se estava desabilitado
      const msgErroLower = erro.message?.toLowerCase() || "";
       if (!msgErroLower.includes('desabilitada') && !msgErroLower.includes('grande') && !msgErroLower.includes('segurança')) { // Adicionado 'segurança'
          try {
             await servicoMensagem.enviarResposta(
                mensagem,
                'Desculpe, ocorreu um erro inesperado ao tentar processar o vídeo.'
             );
          } catch (erroEnvio) {
             registrador.error(`[Video] Falha ao enviar mensagem de erro geral: ${erroEnvio.message}`);
          }
       }
      return Resultado.falha(erro);
    }
  }; // Fim de processarMensagemVideo

  return { processarMensagemVideo };
};

module.exports = criarProcessadorVideo;