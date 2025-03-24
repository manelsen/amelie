/**
 * ComandoLongo - Implementação do comando longo
 */
const _ = require('lodash/fp');
const { Resultado, Trilho } = require('../../../../utilitarios/Ferrovia');
const { criarComando } = require('../ComandoBase');

const criarComandoLongo = (dependencias) => {
  const { registrador, gerenciadorConfig, servicoMensagem } = dependencias;
  
  const executar = (mensagem, args, chatId) => {
    const BOT_NAME = process.env.BOT_NAME || 'Amélie';

    // Pipeline para ativar modo de descrição longa
    return Trilho.encadear(
      // Configurar explicitamente para usar descrição longa
      () => Trilho.dePromise(gerenciadorConfig.definirConfig(chatId, 'mediaImage', true)),
      () => Trilho.dePromise(gerenciadorConfig.definirConfig(chatId, 'mediaVideo', true)),
      () => Trilho.dePromise(gerenciadorConfig.definirConfig(chatId, 'modoDescricao', 'longo')),
      
      // Forçar a atualização do banco de dados
      () => Trilho.dePromise(gerenciadorConfig.definirConfig(chatId, 'descricaoLonga', true)),
      () => Trilho.dePromise(gerenciadorConfig.definirConfig(chatId, 'descricaoCurta', false)),
      
      // Enviar confirmação
      () => {
        registrador.debug(`Modo longo ativado para ${chatId}, verificando configuração...`);
        return Trilho.dePromise(gerenciadorConfig.obterConfig(chatId));
      },
      
      config => {
        registrador.debug(`Modo de descrição atual: ${config.modoDescricao}`);
        return Trilho.dePromise(servicoMensagem.enviarResposta(
          mensagem, 
          'Modo de descrição longa e detalhada ativado para imagens e vídeos. Toda mídia visual será descrita com o máximo de detalhes possível.'
        ));
      }
    )()
    .then(resultado => {
      if (resultado.sucesso) {
        registrador.debug(`Modo de descrição longa ativado para o chat ${chatId}`);
      }
      return resultado;
    });
  };
  
  return criarComando(
    '.longo', 
    'Usa descrição longa e detalhada para imagens e vídeos', 
    executar
  );
};

module.exports = criarComandoLongo;