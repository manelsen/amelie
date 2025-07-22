/**
 * ComandoImagem - Implementação do comando imagem para ativar/desativar descrição de imagem
 */
const { Resultado } = require('../../../../utilitarios/Ferrovia');
const { criarComando } = require('../ComandoBase');

const criarComandoImagem = (dependencias) => {
  const { registrador, gerenciadorConfig, servicoMensagem } = dependencias;

  const executar = async (mensagem, args, chatId) => { // Marcar como async
    (`[ComandoImagem] Executando para chat ${chatId}`);
    try {
      // 1. Obter configuração atual
      const config = await gerenciadorConfig.obterConfig(chatId);
      const valorAtual = config.mediaImage === true;
      (`[ComandoImagem] Valor atual de mediaImage: ${valorAtual}`);

      // 2. Alternar para o valor oposto
      const novoValor = !valorAtual;
      await gerenciadorConfig.definirConfig(chatId, 'mediaImage', novoValor);
      (`[ComandoImagem] Definido mediaImage para: ${novoValor}`);

      // 3. Informar o usuário sobre a nova configuração
      const mensagemStatus = novoValor ? 'ativada' : 'desativada';
      const feedbackMsg = `A descrição de imagem foi ${mensagemStatus} para este chat.`;

      (`[ComandoImagem] Enviando feedback: "${feedbackMsg}"`);
      await servicoMensagem.enviarResposta(mensagem, feedbackMsg);
      (`[ComandoImagem] Feedback enviado com sucesso para ${chatId}`);

      return Resultado.sucesso(true); // Indicar sucesso

    } catch (erro) {
      registrador.error(`[ComandoImagem] Erro ao executar para chat ${chatId}: ${erro.message}`, erro);
      // Tentar enviar mensagem de erro genérica
      try {
        await servicoMensagem.enviarResposta(mensagem, 'Ops! Ocorreu um erro ao tentar alterar a configuração de imagem.');
      } catch (erroEnvio) {
        registrador.error(`[ComandoImagem] Falha ao enviar mensagem de erro: ${erroEnvio.message}`);
      }
      return Resultado.falha(erro); // Indicar falha
    }
  };

  return criarComando(
    'imagem',
    'Liga/desliga a descrição de imagem',
    executar
  );
};

module.exports = criarComandoImagem;