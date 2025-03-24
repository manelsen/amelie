/**
 * ComandoCurto - Implementação do comando curto
 */
const _ = require('lodash/fp');
const { Resultado, Trilho } = require('../../../../utilitarios/Ferrovia');
const { criarComando } = require('../ComandoBase');

const criarComandoCurto = (dependencias) => {
  const { registrador, gerenciadorConfig, servicoMensagem } = dependencias;
  
  const executar = (mensagem, args, chatId) => {
    const BOT_NAME = process.env.BOT_NAME || 'Amélie';

    // Pipeline para ativar modo de descrição curta
    return Trilho.encadear(
      // Configurar explicitamente para usar descrição curta
      () => Trilho.dePromise(gerenciadorConfig.definirConfig(chatId, 'mediaImage', true)),
      () => Trilho.dePromise(gerenciadorConfig.definirConfig(chatId, 'mediaVideo', true)),
      () => Trilho.dePromise(gerenciadorConfig.definirConfig(chatId, 'modoDescricao', 'curto')),
      
      // Forçar a atualização do banco de dados
      () => Trilho.dePromise(gerenciadorConfig.definirConfig(chatId, 'descricaoLonga', false)),
      () => Trilho.dePromise(gerenciadorConfig.definirConfig(chatId, 'descricaoCurta', true)),
      
      // Enviar confirmação
      () => {
        registrador.info(`Modo curto ativado para ${chatId}, verificando configuração...`);
        return Trilho.dePromise(gerenciadorConfig.obterConfig(chatId));
      },
      
      config => {
        registrador.info(`Modo de descrição atual: ${config.modoDescricao}`);
        return Trilho.dePromise(servicoMensagem.enviarResposta(
          mensagem, 
          'Modo de descrição curta e concisa ativado para imagens e vídeos. Toda mídia visual será descrita de forma breve e objetiva, limitado a cerca de 200 caracteres.'
        ));
      }
    )()
    .then(resultado => {
      if (resultado.sucesso) {
        registrador.debug(`Modo de descrição curta ativado para o chat ${chatId}`);
      }
      return resultado;
    });
  };
  
  return criarComando(
    '.curto', 
    'Usa descrição curta e concisa para imagens e vídeos', 
    executar
  );
};

module.exports = criarComandoCurto;