/**
 * ProcessadorAudio - Processamento específico para mensagens de áudio
 */
const _ = require('lodash/fp');
const { Resultado, Trilho } = require('../../../utilitarios/Ferrovia');
const crypto = require('crypto');
const { obterOuCriarUsuario } = require('../dominio/OperacoesChat');

const criarProcessadorAudio = (dependencias) => {
  const {
    registrador,
    adaptadorIA, 
    gerenciadorConfig,
    gerenciadorTransacoes,
    servicoMensagem,
    clienteWhatsApp
  } = dependencias;

  // Função helper para verificar tamanho (mantida)
  const verificarTamanhoAudio = _.curry((dadosAnexo, limiteMB = 20) => {
    const tamanhoAudioMB = dadosAnexo.data.length / (1024 * 1024);
    if (tamanhoAudioMB > limiteMB) {
      return Resultado.falha(new Error(`Áudio muito grande (${tamanhoAudioMB.toFixed(2)}MB). Limite: ${limiteMB}MB`));
    }
    return Resultado.sucesso(dadosAnexo);
  });

  const processarMensagemAudio = async (dados) => {
    const { mensagem, chatId, dadosAnexo } = dados;
    let transacaoId = null; // Para log em caso de erro

    try {
      const config = await gerenciadorConfig.obterConfig(chatId);

      if (!config || !config.mediaAudio) {
        registrador.info(`[ProcessadorAudio] Transcrição de áudio DESABILITADA para ${chatId}. Ignorando áudio.`);
        return Resultado.falha(new Error("Transcrição de áudio desabilitada"));
      }

      const chat = await mensagem.getChat();

      const resultadoRemetente = await obterOuCriarUsuario(gerenciadorConfig, clienteWhatsApp, registrador)(
        mensagem.author || mensagem.from,
        chat
      );
      if (!resultadoRemetente.sucesso) {
           registrador.error(`[ProcessadorAudio] Falha ao obter remetente para ${chatId}: ${resultadoRemetente.erro?.message}`);
           throw new Error("Falha ao obter remetente");
      }
      const remetente = resultadoRemetente.dados;
      const resultadoTamanho = verificarTamanhoAudio(dadosAnexo);
      if (!resultadoTamanho.sucesso) {
        registrador.warn(`[ProcessadorAudio] Áudio muito grande para ${chatId}: ${resultadoTamanho.erro.message}`);
        await servicoMensagem.enviarResposta(
          mensagem,
          'Desculpe, só posso processar áudios de até 20MB.'
        );
        return Resultado.falha(resultadoTamanho.erro); // Parar aqui
      }
      const ehPTT = dadosAnexo.mimetype === 'audio/ogg; codecs=opus';
      const hashAudio = crypto.createHash('md5').update(dadosAnexo.data).digest('hex');
      const resultadoTransacao = await gerenciadorTransacoes.criarTransacao(mensagem, chat);
       if (!resultadoTransacao.sucesso) {
           registrador.error(`[ProcessadorAudio] Falha ao criar transação para ${chatId}: ${resultadoTransacao.erro?.message}`);
           throw new Error("Falha ao criar transação");
       }
      const transacao = resultadoTransacao.dados;
      transacaoId = transacao.id;
      await gerenciadorTransacoes.marcarComoProcessando(transacao.id);
      const resultadoIA = await adaptadorIA.processarAudio(dadosAnexo, hashAudio, config);

      if (!resultadoIA.sucesso) {
        registrador.error(`[ProcessadorAudio] Falha no adaptadorIA.processarAudio para ${transacaoId}: ${resultadoIA.erro?.message}`);
        if (resultadoIA.erro?.message?.includes('segurança')) {
             await servicoMensagem.enviarResposta(mensagem, 'Este conteúdo não pôde ser processado por questões de segurança.', transacaoId);
             await gerenciadorTransacoes.registrarFalhaEntrega(transacaoId, "Conteúdo bloqueado por segurança");
             return Resultado.falha(resultadoIA.erro);
        }
        throw new Error(`Falha no processamento da IA: ${resultadoIA.erro?.message}`);
      }
      const resposta = resultadoIA.dados; // A transcrição
      registrador.info(`[ProcessadorAudio] Transcrição recebida da IA para ${transacaoId}. Tamanho: ${resposta?.length || 0}`);
      await gerenciadorTransacoes.adicionarRespostaTransacao(transacao.id, resposta);
      const resultadoEnvio = await servicoMensagem.enviarResposta(mensagem, resposta, transacao.id);
      if (!resultadoEnvio.sucesso) {
           // ServicoMensagem trata falhas de envio (reenvio, notificação), logar o erro aqui.
           registrador.error(`[ProcessadorAudio] Falha reportada por servicoMensagem ao enviar resposta para ${transacaoId}: ${resultadoEnvio.erro?.message}`);
           // Não lançar erro aqui, pois a IA pode ter funcionado. O problema foi o envio.
      } else {
           registrador.info(`[ProcessadorAudio] Resposta (transcrição) enviada com sucesso para ${transacaoId}`);
      }
      return Resultado.sucesso({ transacao, resposta });

    } catch (erro) {
      registrador.error(`[ProcessadorAudio] ERRO GERAL no processamento para msg ${mensagem?.id?._serialized} / chat ${chatId} / transação ${transacaoId}: ${erro.message}`, erro);

      if (transacaoId) {
          try {
              await gerenciadorTransacoes.registrarFalhaEntrega(transacaoId, `Erro processamento áudio: ${erro.message}`);
          } catch (errTransacao) {
               registrador.error(`[ProcessadorAudio] Falha ao registrar erro na transação ${transacaoId}: ${errTransacao.message}`);
          }
      }

      const msgErroLower = erro.message?.toLowerCase() || "";
      if (!msgErroLower.includes('desabilitada') && !msgErroLower.includes('grande') && !msgErroLower.includes('segurança')) {
         try {
            await servicoMensagem.enviarResposta(
               mensagem,
               'Desculpe, ocorreu um erro inesperado ao tentar transcrever o áudio.'
            );
         } catch (erroEnvio) {
            registrador.error(`[ProcessadorAudio] Falha ao enviar mensagem de erro geral: ${erroEnvio.message}`);
         }
      }

      return Resultado.falha(erro);
    }
  };

  return { processarMensagemAudio };
};

module.exports = criarProcessadorAudio;