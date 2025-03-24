/**
 * ComandoReset - Implementação do comando reset
 */
const _ = require('lodash/fp');
const { Resultado, Trilho } = require('../../../../utilitarios/Ferrovia');
const { criarComando } = require('../ComandoBase');

const criarComandoReset = (dependencias) => {
  const { registrador, gerenciadorConfig, servicoMensagem } = dependencias;
  
  // Pipeline funcional para executar o comando
  const executar = (mensagem, args, chatId) => 
    Trilho.encadear(
      () => Trilho.dePromise(gerenciadorConfig.resetarConfig(chatId)),
      () => Trilho.dePromise(gerenciadorConfig.limparPromptSistemaAtivo(chatId)),
      () => Trilho.dePromise(servicoMensagem.enviarResposta(
        mensagem,
        'Configurações resetadas para este chat. As transcrições de áudio e imagem foram habilitadas, e os prompts especiais foram desativados.'
      ))
    )()
    .then(resultado => {
      if (resultado.sucesso) {
        registrador.debug(`Configurações resetadas para o chat ${chatId}`);
      }
      return resultado;
    });
  
  return criarComando(
    '.reset', 
    'Restaura todas as configurações originais e desativa o modo cego', 
    executar
  );
};

module.exports = criarComandoReset;