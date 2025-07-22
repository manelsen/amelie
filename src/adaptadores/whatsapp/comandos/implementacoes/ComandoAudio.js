/**
 * ComandoAudio - Implementação do comando audio para ativar/desativar transcrição de áudio
 */
const { Resultado } = require('../../../../utilitarios/Ferrovia');
const { criarComando } = require('../ComandoBase');

const criarComandoAudio = (dependencias) => {
  const { registrador, gerenciadorConfig, servicoMensagem } = dependencias;

  const executar = async (mensagem, args, chatId) => { // Marcar como async
    let configAntes; // Variável para guardar a config lida inicialmente
    let novoValor; // Variável para guardar o valor que tentamos definir

    try {
      // 1. Obter configuração atual
      configAntes = await gerenciadorConfig.obterConfig(chatId);
      if (!configAntes) {
           registrador.error(`[CmdAud] Falha ao obter config inicial.`); // Simplificado
           throw new Error("Configuração não encontrada");
      }
      const valorAtual = configAntes.mediaAudio === true;
      // 2. Calcular e tentar definir o novo valor
      novoValor = !valorAtual; // Guardar o valor que vamos tentar definir

      // *** Chamada para definir a configuração ***
      const setResult = await gerenciadorConfig.definirConfig(chatId, 'mediaAudio', novoValor);

      // *** LOG IMPORTANTE: Verificar o resultado da operação de escrita ***

      // 3. *** VERIFICAÇÃO: Re-ler a configuração para confirmar a escrita ***
      const configApos = await gerenciadorConfig.obterConfig(chatId);
      if (!configApos) {
           registrador.error(`[CmdAud] Falha ao obter config APÓS tentativa de escrita.`); // Simplificado
      } else if (configApos.mediaAudio !== novoValor) {
           registrador.error(`[CmdAud] *** VERIFICAÇÃO FALHOU! mediaAudio no DB é ${configApos.mediaAudio}, mas deveria ser ${novoValor} ***`);
      } else {
            // Simplificado
      }

      // 4. Informar o usuário sobre a nova configuração (baseado no 'novoValor' calculado, não no lido após)
      const mensagemStatus = novoValor ? 'ativada' : 'desativada';
      const feedbackMsg = `A transcrição de áudio foi ${mensagemStatus} para este chat.`;

      // *** Adicionar log INFO antes de tentar enviar ***
       // Simplificado
      await servicoMensagem.enviarResposta(mensagem, feedbackMsg);
       // Simplificado

      return Resultado.sucesso(true); // Indicar sucesso da execução do comando

    } catch (erro) {
      // Logar o valor que foi lido e o que se tentou definir pode ajudar
      registrador.error(`[CmdAud] Erro ao executar (Lido: ${configAntes?.mediaAudio}, Tentado: ${novoValor}): ${erro.message}`, erro); // Simplificado
      // Tentar enviar mensagem de erro genérica
      try {
        await servicoMensagem.enviarResposta(mensagem, 'Ops! Ocorreu um erro ao tentar alterar a configuração de áudio.');
      } catch (erroEnvio) {
        registrador.error(`[CmdAud] Falha ao enviar mensagem de erro: ${erroEnvio.message}`);
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
