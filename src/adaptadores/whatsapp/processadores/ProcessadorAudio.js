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
        registrador.debug(`[Audio] Transcrição DESABILITADA. Ignorando.`); // Simplificado
        return Resultado.falha(new Error("Transcrição de áudio desabilitada"));
      }

      const chat = await mensagem.getChat();

      const resultadoRemetente = await obterOuCriarUsuario(gerenciadorConfig, clienteWhatsApp, registrador)(
        mensagem.author || mensagem.from,
        chat
      );
      if (!resultadoRemetente.sucesso) {
           registrador.error(`[Audio] Falha ao obter remetente: ${resultadoRemetente.erro?.message}`);
           throw new Error("Falha ao obter remetente");
      }
      const remetente = resultadoRemetente.dados;
      const resultadoTamanho = verificarTamanhoAudio(dadosAnexo);
      if (!resultadoTamanho.sucesso) {
        registrador.warn(`[Audio] Áudio muito grande: ${resultadoTamanho.erro.message}`); // Simplificado
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
           registrador.error(`[Audio] Falha ao criar transação: ${resultadoTransacao.erro?.message}`);
           throw new Error("Falha ao criar transação");
       }
      const transacao = resultadoTransacao.dados;
      transacaoId = transacao.id;
      await gerenciadorTransacoes.marcarComoProcessando(transacao.id);
      const resultadoIA = await adaptadorIA.processarAudio(dadosAnexo, hashAudio, config);

      if (!resultadoIA.sucesso) {
        registrador.error(`[Audio] Falha no adaptadorIA.processarAudio: ${resultadoIA.erro?.message}`); // Simplificado (ID na coluna)
        if (resultadoIA.erro?.message?.includes('segurança')) {
             await servicoMensagem.enviarResposta(mensagem, 'Este conteúdo não pôde ser processado por questões de segurança.', transacaoId);
             await gerenciadorTransacoes.registrarFalhaEntrega(transacaoId, "Conteúdo bloqueado por segurança");
             return Resultado.falha(resultadoIA.erro);
        }
        throw new Error(`Falha no processamento da IA: ${resultadoIA.erro?.message}`);
      }
      const resposta = resultadoIA.dados; // A transcrição
      registrador.info(`[Audio] Transcrição recebida da IA. Tamanho: ${resposta?.length || 0}`); // Simplificado (ID na coluna)
      await gerenciadorTransacoes.adicionarRespostaTransacao(transacao.id, resposta);
      const resultadoEnvio = await servicoMensagem.enviarResposta(mensagem, resposta, transacao.id);
      if (!resultadoEnvio.sucesso) {
           // ServicoMensagem trata falhas de envio (reenvio, notificação), logar o erro aqui.
           registrador.error(`[Audio] Falha reportada por servicoMensagem ao enviar resposta: ${resultadoEnvio.erro?.message}`); // Simplificado (ID na coluna)
           // Não lançar erro aqui, pois a IA pode ter funcionado. O problema foi o envio.
      } else {
           registrador.info(`[Audio] Resposta (transcrição) enviada com sucesso.`); // Simplificado (ID na coluna)
      }
      return Resultado.sucesso({ transacao, resposta });

    } catch (erro) {
      registrador.error(`[Audio] ERRO GERAL no processamento: ${erro.message}`, erro); // Simplificado (ID na coluna)

      if (transacaoId) {
          try {
              await gerenciadorTransacoes.registrarFalhaEntrega(transacaoId, `Erro processamento áudio: ${erro.message}`);
          } catch (errTransacao) {
               registrador.error(`[Audio] Falha ao registrar erro na transação: ${errTransacao.message}`); // Simplificado (ID na coluna)
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
            registrador.error(`[Audio] Falha ao enviar mensagem de erro geral: ${erroEnvio.message}`);
         }
      }

      return Resultado.falha(erro);
    }
  };

  return { processarMensagemAudio };
};

module.exports = criarProcessadorAudio;
