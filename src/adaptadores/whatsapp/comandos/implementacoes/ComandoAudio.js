/**
 * ComandoAudio - Implementação do comando audio para ativar/desativar transcrição de áudio
 */
const { Resultado } = require('../../../../utilitarios/Ferrovia');
const { criarComando } = require('../ComandoBase');

const criarComandoAudio = (dependencias) => {
  const { registrador, gerenciadorConfig, servicoMensagem } = dependencias;

  const executar = async (mensagem, args, chatId) => { // Marcar como async
    registrador.debug(`[ComandoAudio] Executando para chat ${chatId}`);
    let configAntes; // Variável para guardar a config lida inicialmente
    let novoValor; // Variável para guardar o valor que tentamos definir

    try {
      // 1. Obter configuração atual
      registrador.debug(`[ComandoAudio] Obtendo config para ${chatId}...`);
      configAntes = await gerenciadorConfig.obterConfig(chatId);
      if (!configAntes) {
           registrador.error(`[ComandoAudio] Falha ao obter config inicial para ${chatId}`);
           throw new Error("Configuração não encontrada");
      }
      const valorAtual = configAntes.mediaAudio === true;
      registrador.debug(`[ComandoAudio] Valor atual de mediaAudio para ${chatId}: ${valorAtual}`);

      // 2. Calcular e tentar definir o novo valor
      novoValor = !valorAtual; // Guardar o valor que vamos tentar definir
      registrador.debug(`[ComandoAudio] Tentando definir mediaAudio=${novoValor} para ${chatId}...`);

      // *** Chamada para definir a configuração ***
      const setResult = await gerenciadorConfig.definirConfig(chatId, 'mediaAudio', novoValor);

      // *** LOG IMPORTANTE: Verificar o resultado da operação de escrita ***
      // A implementação de definirConfig deveria idealmente retornar algo ou lançar erro.
      // Assumindo que retorna true em sucesso ou lança erro. Se não retornar nada, este log pode não ser útil.
      registrador.debug(`[ComandoAudio] Resultado de definirConfig para ${chatId}: ${JSON.stringify(setResult)}`);
      // Se definirConfig retornar explicitamente false em caso de falha sem erro:
      // if (setResult === false) {
      //      registrador.error(`[ComandoAudio] gerenciadorConfig.definirConfig retornou falha para ${chatId}`);
      //      throw new Error("Falha silenciosa ao salvar configuração de áudio");
      // }

      registrador.info(`[ComandoAudio] Tentativa de definir mediaAudio=${novoValor} para ${chatId} concluída.`);

      // 3. *** VERIFICAÇÃO: Re-ler a configuração para confirmar a escrita ***
      registrador.debug(`[ComandoAudio] Verificando escrita no DB para ${chatId}...`);
      const configApos = await gerenciadorConfig.obterConfig(chatId);
      if (!configApos) {
           registrador.error(`[ComandoAudio] Falha ao obter config APÓS tentativa de escrita para ${chatId}`);
           // Não lançar erro aqui necessariamente, mas logar é crucial
      } else if (configApos.mediaAudio !== novoValor) {
           registrador.error(`[ComandoAudio] *** VERIFICAÇÃO FALHOU! mediaAudio no DB para ${chatId} é ${configApos.mediaAudio}, mas deveria ser ${novoValor} ***`);
           // Você pode decidir lançar um erro aqui se quiser que o comando falhe se a escrita não for confirmada
           // throw new Error("Falha ao confirmar a escrita da configuração de áudio no DB");
      } else {
           registrador.info(`[ComandoAudio] ✅ Verificação da escrita no DB para ${chatId} OK: mediaAudio=${configApos.mediaAudio}`);
      }

      // 4. Informar o usuário sobre a nova configuração (baseado no 'novoValor' calculado, não no lido após)
      const mensagemStatus = novoValor ? 'ativada' : 'desativada';
      const feedbackMsg = `A transcrição de áudio foi ${mensagemStatus} para este chat.`;

      registrador.debug(`[ComandoAudio] Enviando feedback para ${chatId}: "${feedbackMsg}"`);
      await servicoMensagem.enviarResposta(mensagem, feedbackMsg);
      registrador.debug(`[ComandoAudio] Feedback enviado com sucesso para ${chatId}`);

      return Resultado.sucesso(true); // Indicar sucesso da execução do comando

    } catch (erro) {
      // Logar o valor que foi lido e o que se tentou definir pode ajudar
      registrador.error(`[ComandoAudio] Erro ao executar para chat ${chatId} (Lido inicialmente: ${configAntes?.mediaAudio}, Tentado definir: ${novoValor}): ${erro.message}`, erro);
      // Tentar enviar mensagem de erro genérica
      try {
        await servicoMensagem.enviarResposta(mensagem, 'Ops! Ocorreu um erro ao tentar alterar a configuração de áudio.');
      } catch (erroEnvio) {
        registrador.error(`[ComandoAudio] Falha ao enviar mensagem de erro: ${erroEnvio.message}`);
      }
      return Resultado.falha(erro); // Indicar falha
    }
  };

  return criarComando(
    'audio',
    'Liga/desliga a transcrição de áudio',
    executar
  );
};

module.exports = criarComandoAudio;