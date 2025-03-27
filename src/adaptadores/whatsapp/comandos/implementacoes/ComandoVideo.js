/**
 * ComandoVideo - Implementação do comando video para ativar/desativar interpretação de vídeo
 */
const { Resultado } = require('../../../../utilitarios/Ferrovia');
const { criarComando } = require('../ComandoBase');

const criarComandoVideo = (dependencias) => {
  const { registrador, gerenciadorConfig, servicoMensagem } = dependencias;

  const executar = async (mensagem, args, chatId) => { // Marcar como async
    registrador.debug(`[ComandoVideo] Executando para chat ${chatId}`);
    try {
      // 1. Obter configuração atual
      const config = await gerenciadorConfig.obterConfig(chatId);
      const valorAtual = config.mediaVideo === true;
      registrador.debug(`[ComandoVideo] Valor atual de mediaVideo: ${valorAtual}`);

      // 2. Alternar para o valor oposto
      const novoValor = !valorAtual;
      await gerenciadorConfig.definirConfig(chatId, 'mediaVideo', novoValor);
      registrador.debug(`[ComandoVideo] Definido mediaVideo para: ${novoValor}`);

      // 3. Informar o usuário sobre a nova configuração
      const mensagemStatus = novoValor ? 'ativada' : 'desativada';
      const feedbackMsg = `A interpretação de vídeo foi ${mensagemStatus} para este chat.`;

      registrador.debug(`[ComandoVideo] Enviando feedback: "${feedbackMsg}"`);
      await servicoMensagem.enviarResposta(mensagem, feedbackMsg);
      registrador.debug(`[ComandoVideo] Feedback enviado com sucesso para ${chatId}`);

      return Resultado.sucesso(true); // Indicar sucesso

    } catch (erro) {
      registrador.error(`[ComandoVideo] Erro ao executar para chat ${chatId}: ${erro.message}`, erro);
      // Tentar enviar mensagem de erro genérica
      try {
        await servicoMensagem.enviarResposta(mensagem, 'Ops! Ocorreu um erro ao tentar alterar a configuração de vídeo.');
      } catch (erroEnvio) {
        registrador.error(`[ComandoVideo] Falha ao enviar mensagem de erro: ${erroEnvio.message}`);
      }
      return Resultado.falha(erro); // Indicar falha
    }
  };

  return criarComando(
    'video',
    'Liga/desliga a interpretação de vídeo',
    executar
  );
};

module.exports = criarComandoVideo;